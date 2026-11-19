import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { createFileWriteAdmission } from '../src/main/agent/engine/in-process/native-file-write-resources'

const execFileAsync = promisify(execFile)

type AdmissionEvent = 'entered' | 'waiting' | 'settled'

interface ObservedWrite<T> {
  firstEvent: Promise<AdmissionEvent>
  result: Promise<T>
  waits: boolean[]
}

interface HeldWrite extends ObservedWrite<void> {
  release: () => void
}

interface Fixture {
  root: string
  write<T>(path: string, mutate: () => Promise<T>, signal?: AbortSignal): ObservedWrite<T>
  hold(path: string, mutate?: () => Promise<void>, signal?: AbortSignal): HeldWrite
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-native-file-write-')))
  const admit = createFileWriteAdmission()
  const results: Promise<unknown>[] = []
  const releases: (() => void)[] = []

  t.after(async () => {
    for (const release of releases) release()
    await Promise.allSettled(results)
    await rm(root, { recursive: true, force: true })
  })

  function write<T>(
    path: string,
    mutate: () => Promise<T>,
    signal?: AbortSignal
  ): ObservedWrite<T> {
    const observed = Promise.withResolvers<AdmissionEvent>()
    const waits: boolean[] = []
    const result = admit(
      path,
      signal,
      () => {
        observed.resolve('entered')
        return mutate()
      },
      (waiting) => {
        waits.push(waiting)
        if (waiting) observed.resolve('waiting')
      }
    )
    const settle = (): void => observed.resolve('settled')
    void result.then(settle, settle)
    results.push(result)
    return { firstEvent: observed.promise, result, waits }
  }

  function hold(path: string, mutate?: () => Promise<void>, signal?: AbortSignal): HeldWrite {
    const barrier = Promise.withResolvers<void>()
    releases.push(barrier.resolve)
    const operation = write(
      path,
      async () => {
        await barrier.promise
        await mutate?.()
      },
      signal
    )
    return { ...operation, release: barrier.resolve }
  }

  return { root, write, hold }
}

const options = { timeout: 5000 }

for (const aliasKind of ['directory symlink', 'leaf symlink', 'hard link'] as const) {
  test(`native writes serialize an existing target with its ${aliasKind}`, options, async (t) => {
    const { root, write, hold } = await fixture(t)
    const directory = join(root, 'real')
    const target = join(directory, 'report.txt')
    await mkdir(directory)
    await writeFile(target, 'initial')

    let alias = join(root, 'alias.txt')
    switch (aliasKind) {
      case 'directory symlink': {
        const directoryAlias = join(root, 'alias')
        await symlink(directory, directoryAlias, 'dir')
        alias = join(directoryAlias, 'report.txt')
        break
      }
      case 'leaf symlink':
        await symlink(target, alias, 'file')
        break
      case 'hard link':
        await link(target, alias)
        break
    }

    const first = hold(target, () => writeFile(target, 'first'))
    assert.equal(await first.firstEvent, 'entered')
    const second = write(alias, () => writeFile(alias, 'second'))
    assert.equal(await second.firstEvent, 'waiting')
    assert.equal(await readFile(target, 'utf8'), 'initial')

    first.release()
    await Promise.all([first.result, second.result])
    assert.deepEqual(second.waits, [true, false])
    assert.equal(await readFile(target, 'utf8'), 'second')
  })
}

test(
  'native writes serialize new targets reached through a symlink and missing parents',
  options,
  async (t) => {
    const { root, write, hold } = await fixture(t)
    const directory = join(root, 'real')
    const directoryAlias = join(root, 'alias')
    const target = join(directory, 'missing', 'nested', 'report.txt')
    const alias = join(directoryAlias, 'missing', 'nested', 'report.txt')
    await mkdir(directory)
    await symlink(directory, directoryAlias, 'dir')

    const first = hold(target, async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'first')
    })
    assert.equal(await first.firstEvent, 'entered')
    const second = write(alias, () => writeFile(alias, 'second'))
    assert.equal(await second.firstEvent, 'waiting')
    await assert.rejects(readFile(target), { code: 'ENOENT' })

    first.release()
    await Promise.all([first.result, second.result])
    assert.equal(await readFile(target, 'utf8'), 'second')
  }
)

test('a native write aborted while queued never mutates the target', options, async (t) => {
  const { root, write, hold } = await fixture(t)
  const target = join(root, 'report.txt')
  await writeFile(target, 'initial')
  const controller = new AbortController()
  const first = hold(target, () => writeFile(target, 'first'))
  assert.equal(await first.firstEvent, 'entered')
  let attempted = false
  const cancelled = write(
    target,
    () => {
      attempted = true
      return writeFile(target, 'cancelled')
    },
    controller.signal
  )
  assert.equal(await cancelled.firstEvent, 'waiting')

  controller.abort()
  await assert.rejects(cancelled.result, { name: 'AbortError' })
  assert.equal(await readFile(target, 'utf8'), 'initial')
  const next = write(target, () => readFile(target, 'utf8'))
  assert.equal(await next.firstEvent, 'waiting')

  first.release()
  assert.equal(await next.result, 'first')
  assert.equal(attempted, false)
})

test(
  'a running native write holds its target until its callback settles after cancellation',
  options,
  async (t) => {
    const { root, write, hold } = await fixture(t)
    const target = join(root, 'report.txt')
    const controller = new AbortController()
    const first = hold(target, () => writeFile(target, 'in-flight write'), controller.signal)
    assert.equal(await first.firstEvent, 'entered')

    controller.abort()
    const second = write(target, () => readFile(target, 'utf8'))
    assert.equal(await second.firstEvent, 'waiting')
    await assert.rejects(readFile(target), { code: 'ENOENT' })

    first.release()
    assert.equal(await second.result, 'in-flight write')
  }
)

test(
  'a queued native write revalidates a symlink redirected to another busy target',
  options,
  async (t) => {
    const { root, write, hold } = await fixture(t)
    const original = join(root, 'original.txt')
    const redirected = join(root, 'redirected.txt')
    const alias = join(root, 'alias.txt')
    await writeFile(original, 'original')
    await writeFile(redirected, 'redirected')
    await symlink(original, alias, 'file')

    const originalHolder = hold(original)
    const redirectedHolder = hold(redirected, () => writeFile(redirected, 'holder finished'))
    assert.equal(await originalHolder.firstEvent, 'entered')
    assert.equal(await redirectedHolder.firstEvent, 'entered')

    const queued = write(alias, async () => {
      assert.equal(await readFile(alias, 'utf8'), 'holder finished')
      await writeFile(alias, 'queued finished')
    })
    assert.equal(await queued.firstEvent, 'waiting')
    await rm(alias)
    await symlink(redirected, alias, 'file')

    const originalFollower = write(original, () => readFile(original, 'utf8'))
    assert.equal(await originalFollower.firstEvent, 'waiting')
    originalHolder.release()
    assert.equal(await originalFollower.result, 'original')
    assert.equal(await readFile(redirected, 'utf8'), 'redirected')

    redirectedHolder.release()
    await queued.result
    assert.equal(await readFile(redirected, 'utf8'), 'queued finished')
  }
)

test(
  'a native write can reach a distinct target while another target is busy',
  options,
  async (t) => {
    const { root, write, hold } = await fixture(t)
    const firstTarget = join(root, 'first', 'report.txt')
    const secondTarget = join(root, 'second', 'report.txt')
    await mkdir(dirname(firstTarget))
    await mkdir(dirname(secondTarget))

    const first = hold(firstTarget, () => writeFile(firstTarget, 'first'))
    assert.equal(await first.firstEvent, 'entered')
    const queued = write(firstTarget, () => writeFile(firstTarget, 'queued'))
    assert.equal(await queued.firstEvent, 'waiting')
    const independent = write(secondTarget, () => writeFile(secondTarget, 'independent'))
    assert.equal(await independent.firstEvent, 'entered')
    await independent.result
    await assert.rejects(readFile(firstTarget), { code: 'ENOENT' })
    assert.equal(await readFile(secondTarget, 'utf8'), 'independent')

    first.release()
    await queued.result
  }
)

test(
  'a native write through a dangling symlink waits for an unrelated busy target',
  options,
  async (t) => {
    const { root, write, hold } = await fixture(t)
    const busy = join(root, 'busy.txt')
    const target = join(root, 'real.txt')
    const dangling = join(root, 'alias.txt')
    await symlink(target, dangling, 'file')

    const first = hold(busy, () => writeFile(busy, 'first'))
    assert.equal(await first.firstEvent, 'entered')
    const second = write(dangling, () => writeFile(dangling, 'second'))
    assert.equal(await second.firstEvent, 'waiting')
    await assert.rejects(readFile(target), { code: 'ENOENT' })

    first.release()
    await Promise.all([first.result, second.result])
    assert.equal(await readFile(busy, 'utf8'), 'first')
    assert.equal(await readFile(target, 'utf8'), 'second')
  }
)

test('a missing destination through a symlink and parent traversal waits for its direct path', async (t) => {
  const { root, hold, write } = await fixture(t)
  const nested = join(root, 'target', 'nested')
  await mkdir(nested, { recursive: true })
  await symlink(nested, join(root, 'alias'), 'dir')
  const target = join(root, 'target', 'new.txt')
  // Keep the parent traversal intact so the operating system follows the symlink first.
  const viaAlias = `${join(root, 'alias')}/../new.txt`
  const first = hold(viaAlias)
  assert.equal(await first.firstEvent, 'entered')
  const second = write(target, () => writeFile(target, 'direct writer'))
  assert.equal(await second.firstEvent, 'waiting')
  first.release()
  await second.result
})

test('the real native write retains its lease through a cancelled formatter', async (t) => {
  const { root } = await fixture(t)
  const source = `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { setTimeout } from 'node:timers/promises'
    import { Settings } from '@oh-my-pi/pi-coding-agent'
    import { configCache } from '@oh-my-pi/pi-coding-agent/lsp/config'
    import { WriteTool } from '@oh-my-pi/pi-coding-agent/tools/write'
    import { installNativeFileWriteResources } from './src/main/agent/engine/in-process/native-file-write-resources.ts'
    const cwd = process.argv[1]
    const target = join(cwd, 'shared.phi-fixture')
    await Bun.write(target, 'original')
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const events = []
    configCache.set(cwd, { servers: {
      fixture: { fileTypes: ['phi-fixture'], isLinter: true, createClient() {
        return { async format(path, content, signal) {
          events.push('formatter entered')
          entered.resolve(signal)
          await release.promise
          await Bun.write(path, content + ' formatted')
          events.push('formatter finished')
          return content + ' formatted'
        }, async lint() { return [] }, dispose() {} }
      } }
    } })
    const settings = Settings.isolated({ lsp: { formatOnWrite: true, diagnosticsOnWrite: false } })
    const first = new WriteTool({ cwd, settings, enableLsp: true })
    const second = new WriteTool({ cwd, settings, enableLsp: false })
    for (const tool of [first, second]) {
      installNativeFileWriteResources({ getToolByName: name => name === 'write' ? tool : undefined })
    }
    const context = { toolCall: {
      index: 0, batchId: 'fixture', toolCalls: [{ id: 'shared-id', name: 'write' }]
    } }
    const controller = new AbortController()
    const running = assert.rejects(
      first.execute('shared-id', { path: 'shared.phi-fixture', content: 'first' },
        controller.signal, undefined, context), /fixture cancelled/
    )
    const formatSignal = await entered.promise
    const queued = Promise.withResolvers()
    const later = second.execute('shared-id', { path: target, content: 'second' }, undefined,
      event => {
        if (event.details.kind === 'phi_local_resource_wait' && event.details.waiting) queued.resolve()
        if (event.details.resolvedPath) events.push('second entered')
      }, context)
    try {
      await queued.promise
      controller.abort(new Error('fixture cancelled'))
      await running
      assert.equal(formatSignal.aborted, true)
      await setTimeout(100)
      assert.deepEqual(events, ['formatter entered'])
      assert.equal(await Bun.file(target).text(), 'first')
    } finally {
      release.resolve()
    }
    await later
    assert.deepEqual(events, ['formatter entered', 'formatter finished', 'second entered'])
    assert.equal(await Bun.file(target).text(), 'second')
  `
  await execFileAsync('bun', ['-e', source, root], {
    timeout: 15_000,
    env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root }
  })
})
