import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('native move destinations and recovered edit sources use the shared write admission', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-native-edit-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = `
    import assert from 'node:assert/strict'
    import { mkdir } from 'node:fs/promises'
    import { join } from 'node:path'
    import { Settings } from '@oh-my-pi/pi-coding-agent'
    import { EditTool, getEditStore } from '@oh-my-pi/pi-coding-agent/edit'
    import { installNativeFileWriteResources } from './src/main/agent/engine/in-process/native-file-write-resources.ts'
    const cwd = process.argv[1]
    const session = {
      cwd, getSessionFile: () => undefined,
      settings: Settings.isolated({ edit: { enforceSeenLines: false } }), enableLsp: false
    }
    let admit
    const capture = { setPhiFileWriteAdmission(admission) { admit = admission } }
    installNativeFileWriteResources({ getToolByName: name => name === 'write' ? capture : undefined })

    async function runAfter(path, mode, args, checkQueued) {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const holder = admit(path, undefined, () => { entered.resolve(); return release.promise })
      await entered.promise
      const edit = new EditTool(session, mode)
      installNativeFileWriteResources({ getToolByName: name => name === 'edit' ? edit : undefined })
      const waiting = Promise.withResolvers()
      const tool = mode === 'apply_patch' ? 'apply_patch' : 'edit'
      const context = { toolCall: { index: 0, batchId: 'fixture', toolCalls: [{ id: 'edit', name: tool }] } }
      const execution = edit.execute('edit', args, undefined,
        event => { if (event.details.kind === 'phi_local_resource_wait' && event.details.waiting) waiting.resolve() },
        context)
      try {
        await Promise.race([waiting.promise, execution.then(() => assert.fail('edit ran without waiting'))])
        await checkQueued()
      } finally {
        release.resolve()
      }
      await holder
      const result = await execution
      assert.equal(result.isError, undefined, JSON.stringify(result.content))
    }

    const from = join(cwd, 'source.txt')
    const to = join(cwd, 'destination.txt')
    await Bun.write(from, 'before\\n')
    await runAfter(to, 'apply_patch', { input: [
      '*** Begin Patch', '*** Update File: source.txt', '*** Move to: destination.txt',
      '@@', '-before', '+after', '*** End Patch'
    ].join('\\n') }, async () => {
      assert.equal(await Bun.file(to).exists(), false)
      assert.equal(await Bun.file(from).text(), 'before\\n')
    })
    assert.equal(await Bun.file(from).exists(), false)
    assert.equal(await Bun.file(to).text(), 'after\\n')

    const nested = join(cwd, 'nested')
    await mkdir(nested)
    const recovered = join(nested, 'report.txt')
    await Bun.write(recovered, 'original\\n')
    const tag = getEditStore(session).recordSnapshot(recovered, 'original\\n')
    await runAfter(recovered, 'hashline', { input: '[report.txt#' + tag + ']\\nPUT 1.=1:\\n+recovered' },
      async () => assert.equal(await Bun.file(recovered).text(), 'original\\n'))
    assert.equal(await Bun.file(recovered).text(), 'recovered\\n')

    const merged = join(cwd, 'merged.txt')
    const moved = join(cwd, 'merged-destination.txt')
    await Bun.write(merged, 'initial\\n')
    const mergedTag = getEditStore(session).recordSnapshot(merged, 'initial\\n')
    await runAfter(moved, 'hashline', { input: [
      '[' + merged + '#' + mergedTag + ']', 'PUT 1.=1:',
      '[merged.txt#' + mergedTag + ']', '+combined', 'MV merged-destination.txt'
    ].join('\\n') }, async () => assert.equal(await Bun.file(merged).text(), 'initial\\n'))
    assert.equal(await Bun.file(merged).exists(), false)
    assert.equal(await Bun.file(moved).text(), 'combined\\n')

    const spaced = join(cwd, ' leading.txt')
    await runAfter(spaced, 'apply_patch', { input: [
      '*** Begin Patch', '*** Add File:  leading.txt', '+preserved', '*** End Patch'
    ].join('\\n') }, async () => assert.equal(await Bun.file(spaced).exists(), false))
    assert.equal(await Bun.file(spaced).text(), 'preserved\\n')
    assert.equal(await Bun.file(join(cwd, 'leading.txt')).exists(), false)

    const malformed = new EditTool(session, 'apply_patch')
    installNativeFileWriteResources({ getToolByName: name => name === 'edit' ? malformed : undefined })
    const malformedResult = await malformed.execute('bad', {
      input: '*** Begin Patch\\n*** Add File: invalid.txt\\n+must not be written'
    }, undefined, undefined, {
      toolCall: { index: 0, batchId: 'bad', toolCalls: [{ id: 'bad', name: 'apply_patch' }] }
    })
    assert.equal(malformedResult.isError, true)
    assert.equal(await Bun.file(join(cwd, 'invalid.txt')).exists(), false)
  `
  await execFileAsync('bun', ['-e', fixture, root], {
    timeout: 15_000,
    env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root }
  })
})

test('cancelled native patch retains the whole batch until its formatter finishes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-native-patch-format-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { setTimeout } from 'node:timers/promises'
    import { Settings } from '@oh-my-pi/pi-coding-agent'
    import { EditTool } from '@oh-my-pi/pi-coding-agent/edit'
    import { configCache } from '@oh-my-pi/pi-coding-agent/lsp/config'
    import { WriteTool } from '@oh-my-pi/pi-coding-agent/tools/write'
    import { installNativeFileWriteResources } from './src/main/agent/engine/in-process/native-file-write-resources.ts'
    const cwd = process.argv[1]
    const a = join(cwd, 'a.fixture')
    const b = join(cwd, 'b.fixture')
    await Bun.write(a, 'initial A\\n')
    await Bun.write(b, 'initial B\\n')
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const writes = []
    configCache.set(cwd, { servers: {
      fixture: { fileTypes: ['fixture'], isLinter: true, createClient() {
        return { async format(path, content, signal) {
          assert.equal(path, a)
          entered.resolve(signal)
          await release.promise
          await Bun.write(path, content)
          writes.push('formatter finished')
          return content
        }, async lint() { return [] }, dispose() {} }
      } }
    } })
    const settings = Settings.isolated({ lsp: { formatOnWrite: true, diagnosticsOnEdit: false } })
    const session = { cwd, getSessionFile: () => undefined, settings, enableLsp: true }
    const edit = new EditTool(session, 'apply_patch')
    const write = new WriteTool({ ...session, enableLsp: false })
    installNativeFileWriteResources({ getToolByName: name => name === 'write' ? write : edit })
    const context = name => ({ toolCall: { index: 0, batchId: name, toolCalls: [{ id: name, name }] } })
    const controller = new AbortController()
    const patch = edit.execute('apply_patch', { input: [
      '*** Begin Patch',
      '*** Update File: a.fixture', '@@', '-initial A', '+patched A',
      '*** Update File: b.fixture', '@@', '-initial B', '+must not be written',
      '*** End Patch'
    ].join('\\n') }, controller.signal, undefined, context('apply_patch'))
    const formatSignal = await Promise.race([
      entered.promise, patch.then(() => assert.fail('patch never reached the formatter'))
    ])
    const queued = Promise.withResolvers()
    const following = write.execute('write', { path: b, content: 'next B\\n' }, undefined, event => {
      if (event.details.kind === 'phi_local_resource_wait' && event.details.waiting) queued.resolve()
      if (event.details.resolvedPath) writes.push('next writer entered')
    }, context('write'))
    try {
      await Promise.race([queued.promise, following.then(() => assert.fail('write did not wait for the batch'))])
      controller.abort(new Error('cancel the batch'))
      assert.equal(formatSignal.aborted, true)
      await setTimeout(100)
      assert.deepEqual(writes, [])
      assert.equal(await Bun.file(b).text(), 'initial B\\n')
    } finally {
      release.resolve()
    }
    assert.equal((await patch).isError, true)
    await following
    assert.deepEqual(writes, ['formatter finished', 'next writer entered'])
    assert.equal(await Bun.file(a).text(), 'patched A\\n')
    assert.equal(await Bun.file(b).text(), 'next B\\n')
  `
  await execFileAsync('bun', ['-e', fixture, root], {
    timeout: 15_000,
    env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root }
  })
})
