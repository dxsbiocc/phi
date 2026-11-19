import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const harness = String.raw`
  import assert from 'node:assert/strict'
  import { join } from 'node:path'
  import { Settings } from '@oh-my-pi/pi-coding-agent'
  import { InternalUrlFilesystem } from '@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem'
  import { ToolChoiceQueue } from '@oh-my-pi/pi-coding-agent/session/tool-choice-queue'
  import { AstEditTool } from '@oh-my-pi/pi-coding-agent/tools/ast-edit'
  import { WriteTool } from '@oh-my-pi/pi-coding-agent/tools/write'
  import { installNativeFileWriteResources } from './src/main/agent/engine/in-process/native-file-write-resources.ts'

  const cwd = process.argv[1]
  const queue = new ToolChoiceQueue()
  const session = {
    cwd, getSessionFile: () => undefined, settings: Settings.isolated(), enableLsp: false,
    getArtifactsDir: () => cwd,
    getToolChoiceQueue: () => queue,
    peekPendingInvoker: () => queue.peekPendingInvoker(),
    clearPendingInvokers: () => queue.clearPendingInvokers()
  }
  const ast = new AstEditTool(session)
  const write = new WriteTool(session)
  let admit
  const edit = { setPhiFileWriteAdmission(admission) { admit = admission } }
  const tools = { ast_edit: ast, edit, write }
  installNativeFileWriteResources({ getToolByName: name => tools[name] })

  const context = (name, id) => ({ toolCall: { index: 0, batchId: id, toolCalls: [{ id, name }] } })
  const text = path => Bun.file(path).text()
  const executeWrite = (id, path, content, signal, onUpdate) =>
    write.execute(id, { path, content }, signal, onUpdate, context('write', id))
  const apply = (id, signal, onUpdate) =>
    executeWrite(id, 'xd://resolve', 'Apply the staged rewrite.', signal, onUpdate)

  async function preview(path, signal, id = 'preview') {
    const result = await ast.execute(id, {
      ops: [{ pat: 'before($X)', out: 'after($X)' }], paths: [path]
    }, signal, undefined, context('ast_edit', id))
    assert.equal(result.details.totalReplacements, 1, JSON.stringify(result.content))
    assert.equal(result.details.applied, false)
    assert.equal(queue.hasPendingInvoker, true)
  }

  async function hold(path) {
    const entered = Promise.withResolvers()
    const released = Promise.withResolvers()
    const result = admit(path, undefined, () => { entered.resolve(); return released.promise })
    await waitFor(entered.promise, result, 'write lease did not start')
    return { release: released.resolve, result }
  }

  function resourceWait() {
    const waiting = Promise.withResolvers()
    return {
      promise: waiting.promise,
      onUpdate(event) {
        if (event.details.kind === 'phi_local_resource_wait' && event.details.waiting) waiting.resolve()
      }
    }
  }

  async function waitFor(event, operation, failure) {
    await Promise.race([event, operation.then(result => assert.fail(failure + ': ' + JSON.stringify(result)))])
  }
`

async function runFixture(t: TestContext, source: string): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-native-ast-edit-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  try {
    await execFileAsync('bun', ['-e', harness + source, root], {
      timeout: 15_000,
      env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root }
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    if (stderr) throw new Error(stderr)
    throw error
  }
}

test('AST previews bypass active writes and aborting a queued resolve leaves no pending mutation', async (t) => {
  await runFixture(
    t,
    String.raw`
    const path = join(cwd, 'target.ts')
    await Bun.write(path, 'before(1);\n')
    const holder = await hold(path)
    try {
      await preview(path)
      assert.equal(await text(path), 'before(1);\n')

      const stop = new AbortController()
      const waiting = resourceWait()
      const applying = apply('queued', stop.signal, waiting.onUpdate)
      await waitFor(waiting.promise, applying, 'resolve did not wait for the target')
      stop.abort(new Error('cancel queued AST apply'))
      await assert.rejects(applying, /cancel queued AST apply/)
      assert.equal(await text(path), 'before(1);\n')
    } finally {
      holder.release()
    }
    await holder.result

    // Enter behind any queued mutation, then confirm the file stayed intact.
    await admit(path, undefined, async () => assert.equal(await text(path), 'before(1);\n'))
    assert.equal(queue.hasPendingInvoker, false)
    await assert.rejects(apply('stale'), /no pending action/i)
    assert.equal(await text(path), 'before(1);\n')
  `
  )
})

test('aborting a staged AST preview invalidates its pending action before resolve', async (t) => {
  await runFixture(
    t,
    String.raw`
    const path = join(cwd, 'target.ts')
    await Bun.write(path, 'before(1);\n')
    const stop = new AbortController()
    await preview(path, stop.signal)
    stop.abort()

    assert.equal(queue.hasPendingInvoker, false)
    await assert.rejects(apply('stale'), /no pending action/i)
    assert.equal(await text(path), 'before(1);\n')
  `
  )
})

test('rejecting an AST preview bypasses an active write lease and leaves the file intact', async (t) => {
  await runFixture(
    t,
    String.raw`
    const path = join(cwd, 'target.ts')
    await Bun.write(path, 'before(1);\n')
    await preview(path)
    const holder = await hold(path)
    try {
      const waiting = resourceWait()
      const rejecting = executeWrite('reject', 'xd://reject', 'Discard the preview.', undefined, waiting.onUpdate)
      const result = await Promise.race([
        rejecting,
        waiting.promise.then(() => assert.fail('reject waited for a write lease'))
      ])
      assert.equal(result.isError, undefined, JSON.stringify(result.content))
      assert.equal(result.details.xdev.inner.action, 'discard')
      assert.equal(queue.hasPendingInvoker, false)
      assert.equal(await text(path), 'before(1);\n')
    } finally {
      holder.release()
    }
    await holder.result
    assert.equal(await text(path), 'before(1);\n')
  `
  )
})

test('clearing pending actions cancels a queued AST resolve and retires its captured invoker', async (t) => {
  await runFixture(
    t,
    String.raw`
    const path = join(cwd, 'target.ts')
    await Bun.write(path, 'before(1);\n')
    await preview(path)
    const obsolete = queue.peekPendingInvoker()
    assert.equal(typeof obsolete, 'function')
    const holder = await hold(path)
    const waiting = resourceWait()
    const applying = apply('queued', undefined, waiting.onUpdate)
    try {
      await waitFor(waiting.promise, applying, 'resolve did not wait before queue reset')
      queue.clearPendingInvokers()
      await assert.rejects(applying, /abort/i)
      assert.equal(queue.hasPendingInvoker, false)
      await assert.rejects(obsolete({ action: 'apply', reason: 'Obsolete invocation.' }), /no longer available/i)
      assert.equal(await text(path), 'before(1);\n')
    } finally {
      holder.release()
    }
    await holder.result
    await admit(path, undefined, async () => assert.equal(await text(path), 'before(1);\n'))
    assert.equal(queue.hasPendingInvoker, false)
  `
  )
})

test('duplicate AST resolve leaves earlier staged work untouched while the current apply waits', async (t) => {
  await runFixture(
    t,
    String.raw`
    const earlier = join(cwd, 'earlier.ts')
    const current = join(cwd, 'current.ts')
    await Bun.write(earlier, 'before(1);\n')
    await Bun.write(current, 'before(2);\n')
    await preview(earlier)
    await preview(current, undefined, 'preview-current')
    const holder = await hold(current)
    const waiting = resourceWait()
    const applying = apply('current', undefined, waiting.onUpdate)
    try {
      await waitFor(waiting.promise, applying, 'resolve did not wait for the current target')
      const duplicateWait = resourceWait()
      const duplicate = assert.rejects(apply('duplicate', undefined, duplicateWait.onUpdate))
      await Promise.race([
        duplicate,
        duplicateWait.promise.then(() => assert.fail('duplicate resolve joined the file queue'))
      ])
      assert.equal(await text(earlier), 'before(1);\n')
      assert.equal(await text(current), 'before(2);\n')
    } finally {
      holder.release()
    }
    await holder.result
    const result = await applying
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    assert.equal(await text(current), 'after(2);\n')
    assert.equal(await text(earlier), 'before(1);\n')
    const previous = await apply('earlier')
    assert.equal(previous.isError, undefined, JSON.stringify(previous.content))
    assert.equal(await text(earlier), 'after(1);\n')
  `
  )
})

test('a cancelled AST resolve holds the backing path through the real native write', async (t) => {
  await runFixture(
    t,
    String.raw`
    const path = join(cwd, 'local', 'target.ts')
    await Bun.write(path, 'before(1);\n')
    const opened = Promise.withResolvers()
    const release = Promise.withResolvers()
    const shellFilesystem = InternalUrlFilesystem.prototype.shellFilesystem
    let writeOpens = 0
    // Pause only the actual native write. Preview reads use the original filesystem.
    InternalUrlFilesystem.prototype.shellFilesystem = function () {
      const filesystem = shellFilesystem.call(this)
      return {
        ...filesystem,
        async handler(error, request) {
          if (request.path === 'local://target.ts' && request.op === 'open' && request.open?.write) {
            writeOpens++
            opened.resolve()
            await release.promise
          }
          return filesystem.handler(error, request)
        }
      }
    }

    await preview('local://target.ts')
    const stop = new AbortController()
    const applying = apply('running', stop.signal)
    let following
    try {
      await waitFor(opened.promise, applying, 'resolve never reached the native write')
      stop.abort(new Error('cancel running AST apply'))
      await assert.rejects(applying, /cancel running AST apply/)
      const waiting = resourceWait()
      following = executeWrite('following', path, 'following();\n', undefined, waiting.onUpdate)
      await waitFor(waiting.promise, following, 'write escaped the running AST lease')
      assert.equal(await text(path), 'before(1);\n')
    } finally {
      release.resolve()
    }
    const result = await following
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    assert.equal(writeOpens, 1)
    assert.equal(await text(path), 'following();\n')
  `
  )
})

test('AST resolve waits for the actual file when the native rewrite trims its decoded path', async (t) => {
  await runFixture(
    t,
    String.raw`
    import { stat } from 'node:fs/promises'
    import { pathToFileURL } from 'node:url'

    const target = join(cwd, 'target.ts')
    const suffixed = target + '\u0085'
    await Bun.write(target, 'before(1);\n')
    await Bun.write(suffixed, 'untouched();\n')
    assert.notEqual((await stat(target, { bigint: true })).ino, (await stat(suffixed, { bigint: true })).ino)
    await preview(pathToFileURL(suffixed).href)

    const holder = await hold(target)
    const waiting = resourceWait()
    const applying = apply('apply-trimmed', undefined, waiting.onUpdate)
    try {
      await waitFor(waiting.promise, applying, 'resolve did not wait for the native target')
      assert.equal(await text(target), 'before(1);\n')
    } finally {
      holder.release()
    }
    await holder.result
    const result = await applying
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    assert.equal(await text(target), 'after(1);\n')
    assert.equal(await text(suffixed), 'untouched();\n')
  `
  )
})

test('a glob AST resolve observes a new matching file from the intervening writer', async (t) => {
  await runFixture(
    t,
    String.raw`
    const original = join(cwd, 'nested', 'first.ts')
    const added = join(cwd, 'nested', 'second.ts')
    await Bun.write(original, 'before(1);\n')
    await preview('nested/*.ts')
    const holder = await hold(added)
    const earlier = resourceWait()
    const intervening = executeWrite('intervening', added, 'before(2);\n', undefined, earlier.onUpdate)
    let applying
    try {
      await waitFor(earlier.promise, intervening, 'intervening write did not wait')
      const waiting = resourceWait()
      applying = apply('glob', undefined, waiting.onUpdate)
      await waitFor(waiting.promise, applying, 'glob resolve did not wait for the intervening writer')
      assert.equal(await text(original), 'before(1);\n')
      assert.equal(await Bun.file(added).exists(), false)
    } finally {
      holder.release()
    }
    await holder.result
    await intervening
    const result = await applying
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /preview is stale/i)
    assert.equal(await text(original), 'after(1);\n')
    assert.equal(await text(added), 'after(2);\n')
  `
  )
})
