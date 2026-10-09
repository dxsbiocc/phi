import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import {
  buildDevelopmentHelper,
  resolveRemoteHelperPreparation
} from '../src/main/agent/workspace-host/helper-development'
import { remoteHelperDevelopmentRoot } from '../src/main/agent/workspace-host/helper-installer'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'

function profile(os = 'Linux', arch = 'aarch64'): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=${os}
platform.arch=${arch}
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-development-'))
  mkdirSync(join(root, 'helper'))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'helper', 'VERSION'), '0.1.0\n')
  writeFileSync(join(root, 'scripts', 'build-helper.mjs'), '')
  return root
}

function publish(root: string, target: string): void {
  const resourceRoot = join(root, 'resources', 'remote-helper')
  const localPath = join(resourceRoot, '0.1.0', target, 'phi-helper')
  mkdirSync(join(resourceRoot, '0.1.0', target), { recursive: true })
  writeFileSync(localPath, `helper ${target}`)
  const sha256 = createHash('sha256').update(readFileSync(localPath)).digest('hex')
  writeFileSync(
    join(resourceRoot, 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      platforms: { [target]: { path: `0.1.0/${target}/phi-helper`, sha256 } }
    })
  )
}

test('development repository resolution accepts source, bundled main, and Electron app path', () => {
  const root = repository()
  try {
    for (const relative of [
      'src/main/agent/workspace-host/helper-installer.ts',
      'out/main/index.mjs'
    ]) {
      assert.equal(
        remoteHelperDevelopmentRoot({ moduleUrl: pathToFileURL(join(root, relative)).href }),
        root
      )
    }
    assert.equal(remoteHelperDevelopmentRoot({ appPath: root }), root)
    assert.equal(remoteHelperDevelopmentRoot({ appPath: root, isPackaged: true }), undefined)
    assert.equal(
      remoteHelperDevelopmentRoot({
        moduleUrl: pathToFileURL(join(tmpdir(), 'unrelated', 'main.mjs')).href
      }),
      undefined
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cold development helper prepares only the selected remote architecture upon use', async () => {
  const root = repository()
  const targets: string[] = []
  try {
    const preparation = resolveRemoteHelperPreparation(profile(), {
      developmentRoot: root,
      runBuild: async (repositoryRoot, target) => {
        targets.push(target)
        publish(repositoryRoot, target)
      }
    })
    assert.deepEqual(targets, [])
    assert.equal(preparation?.artifact.version, '0.1.0')
    assert.equal(preparation?.artifact.localPath, '')
    const artifact = await preparation?.prepareArtifact?.()
    assert.deepEqual(targets, ['linux-arm64'])
    assert.equal(
      artifact?.localPath,
      join(root, 'resources/remote-helper/0.1.0/linux-arm64/phi-helper')
    )
    assert.equal(artifact?.sha256, createHash('sha256').update('helper linux-arm64').digest('hex'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native lazy preparation invokes Node with the selected target only and reuses checked fixture output', async () => {
  const root = repository()
  const target = 'linux-arm64'
  const invocationPath = join(root, 'invocation.json')
  writeFileSync(
    join(root, 'scripts', 'build-helper.mjs'),
    `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const target = process.argv[3]
if (process.argv[2] !== '--target' || target !== '${target}') throw new Error('unexpected target arguments')
if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('missing Node mode')
const root = process.cwd()
const resourceRoot = join(root, 'resources', 'remote-helper')
const output = join(resourceRoot, '0.1.0', target, 'phi-helper')
writeFileSync(join(root, 'invocation.json'), JSON.stringify({ target, cached: existsSync(output) }))
mkdirSync(join(resourceRoot, '0.1.0', target), { recursive: true })
const bytes = 'helper ' + target
writeFileSync(output, bytes)
writeFileSync(join(resourceRoot, 'manifest.json'), JSON.stringify({ version: '0.1.0', platforms: {
  [target]: { path: '0.1.0/' + target + '/phi-helper', sha256: createHash('sha256').update(bytes).digest('hex') }
}}))
`
  )
  try {
    const preparation = resolveRemoteHelperPreparation(profile(), { developmentRoot: root })
    assert.equal(existsSync(invocationPath), false)
    const first = await preparation!.prepareArtifact!()
    assert.deepEqual(JSON.parse(readFileSync(invocationPath, 'utf8')), { target, cached: false })
    const second = await preparation!.prepareArtifact!()
    assert.deepEqual(JSON.parse(readFileSync(invocationPath, 'utf8')), { target, cached: true })
    assert.deepEqual(second, first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packaged and unsupported remote hosts never prepare Go or development artifacts', () => {
  const root = repository()
  try {
    const resourceRoot = join(root, 'resources', 'remote-helper')
    const runBuild = async (): Promise<void> => {
      throw new Error('must not build')
    }
    assert.equal(
      resolveRemoteHelperPreparation(profile(), {
        developmentRoot: root,
        resourceRoot,
        isPackaged: true,
        runBuild
      }),
      undefined
    )
    for (const remote of [profile('Darwin', 'arm64'), profile('Linux', 's390x')]) {
      assert.equal(
        resolveRemoteHelperPreparation(remote, { developmentRoot: root, runBuild }),
        undefined
      )
    }
    publish(root, 'linux-arm64')
    const packaged = resolveRemoteHelperPreparation(profile(), {
      developmentRoot: root,
      resourceRoot,
      isPackaged: true,
      runBuild
    })
    assert.equal(packaged?.prepareArtifact, undefined)
    assert.ok(packaged?.artifact.localPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hosts share a concurrent selected-target build without one cancellation stopping other users', async () => {
  const root = repository()
  const firstHost = new AbortController()
  let builds = 0
  let compilerSignal: AbortSignal | undefined
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  try {
    const preparation = resolveRemoteHelperPreparation(profile(), {
      developmentRoot: root,
      runBuild: async (repositoryRoot, target, signal) => {
        builds += 1
        compilerSignal = signal
        await pending
        publish(repositoryRoot, target)
      }
    })
    const first = assert.rejects(preparation!.prepareArtifact!(firstHost.signal), {
      name: 'AbortError'
    })
    const second = preparation!.prepareArtifact!()
    await delay(0)
    firstHost.abort()
    await first
    assert.equal(builds, 1)
    assert.equal(compilerSignal?.aborted, false)
    finish()
    assert.ok((await second).localPath)
  } finally {
    finish()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the last host cancellation stops its shared compiler and waits for termination', async () => {
  const root = repository()
  const host = new AbortController()
  let compilerStopped = false
  try {
    const preparation = resolveRemoteHelperPreparation(profile(), {
      developmentRoot: root,
      runBuild: async (_root, _target, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              compilerStopped = true
              reject(new Error('stopped'))
            },
            { once: true }
          )
        })
    })
    const result = assert.rejects(preparation!.prepareArtifact!(host.signal), {
      name: 'AbortError'
    })
    await delay(0)
    host.abort()
    await result
    assert.equal(compilerStopped, true)
  } finally {
    host.abort()
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed or corrupt development builds never supply an upload artifact and allow a later retry', async () => {
  const root = repository()
  let attempts = 0
  try {
    const preparation = resolveRemoteHelperPreparation(profile(), {
      developmentRoot: root,
      runBuild: async (repositoryRoot, target) => {
        attempts += 1
        if (attempts === 1) throw new Error('compiler failed')
        publish(repositoryRoot, target)
        if (attempts === 2)
          writeFileSync(
            join(repositoryRoot, 'resources/remote-helper/0.1.0/linux-arm64/phi-helper'),
            'corrupt'
          )
      }
    })
    await assert.rejects(preparation!.prepareArtifact!(), /compiler failed/)
    await assert.rejects(preparation!.prepareArtifact!(), /sha256 mismatch/)
    assert.ok((await preparation!.prepareArtifact!()).localPath)
    assert.equal(attempts, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'development compiler cancellation terminates the owned Node and Go child process group',
  { skip: process.platform === 'win32' },
  async () => {
    const root = repository()
    const controller = new AbortController()
    const childPidPath = join(root, 'child.pid')
    writeFileSync(
      join(root, 'scripts', 'build-helper.mjs'),
      `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
setInterval(() => {}, 1000)
`
    )
    let childPid: number | undefined
    try {
      const result = assert.rejects(
        buildDevelopmentHelper(root, 'linux-arm64', controller.signal),
        { name: 'AbortError' }
      )
      const deadline = Date.now() + 5_000
      while (!existsSync(childPidPath) && Date.now() < deadline) await delay(10)
      assert.ok(existsSync(childPidPath), 'fixture compiler must start its child')
      childPid = Number(readFileSync(childPidPath, 'utf8'))
      controller.abort()
      await result
      const stoppedBy = Date.now() + 2_000
      while (Date.now() < stoppedBy) {
        try {
          process.kill(childPid, 0)
        } catch {
          return
        }
        await delay(10)
      }
      assert.fail('owned compiler child survived cancellation')
    } finally {
      controller.abort()
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          /* already stopped */
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)
