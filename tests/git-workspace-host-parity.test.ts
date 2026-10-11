import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, afterEach, before, test } from 'node:test'
import { promisify } from 'node:util'

import { WorkspaceGitService } from '../src/main/agent/git/workspace-git'
import { HelperWorkspaceHost } from '../src/main/agent/workspace-host/helper-host'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

const execFileAsync = promisify(execFile)
const hosts = new Set<WorkspaceHost>()
let fixtureDirectory = ''
let restoreSetsid = (): void => undefined

function helperProfile(): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
storage.home_writable=1
storage.home_executable=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'phi-git-host-parity-'))
  restoreSetsid = installSetsidShim(fixtureDirectory)
})

afterEach(async () => {
  const closing = [...hosts].flatMap((host) => (host.close ? [host.close()] : []))
  hosts.clear()
  await Promise.all(closing)
})

after(async () => {
  restoreSetsid()
  await rm(fixtureDirectory, { recursive: true, force: true })
})

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function helperProcess(): RemoteStdioProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffer = Buffer.alloc(0)
  let queue = Promise.resolve()
  let resolveClosed: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })

  const respond = async (request: {
    id: number
    method: string
    params: Record<string, unknown>
  }): Promise<void> => {
    assert.equal(request.method, 'exec.run')
    const command = request.params.command as string[]
    const cwd = request.params.cwd as string
    const env = request.params.env as Record<string, string>
    const maxOutputBytes = request.params.maxOutputBytes as number
    const result = await execFileAsync(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: maxOutputBytes
    })
    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          code: 0,
          signal: null,
          truncated: false
        }
      })
    )
  }

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.byteLength >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.byteLength < length + 4) break
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      buffer = buffer.subarray(length + 4)
      queue = queue.then(() => respond(request))
    }
  })

  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      await queue
      stdin.end()
      stdout.end()
      stderr.end()
      resolveClosed!({ code: 0, signal: null })
    }
  }
}

async function localHost(root: string): Promise<WorkspaceHost> {
  const host = new LocalHost(root)
  hosts.add(host)
  return host
}

async function pureSshHost(root: string): Promise<WorkspaceHost> {
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => createLocalShellSession(root)
  })
  hosts.add(host)
  return host
}

async function helperHost(root: string): Promise<WorkspaceHost> {
  const session = createLocalShellSession(root)
  const host = new HelperWorkspaceHost(
    session,
    helperProcess(),
    helperProfile(),
    async () => [],
    undefined,
    { remoteRoot: root, canonicalRoot: root }
  )
  hosts.add(host)
  return host
}

for (const [transport, createHost] of [
  ['LocalHost', localHost],
  ['pure SSH SshHost', pureSshHost],
  ['HelperWorkspaceHost', helperHost]
] as const) {
  test(`summary reports branch and dirty state through ${transport}`, async () => {
    const displayRoot = await mkdtemp(join(tmpdir(), 'phi-git-parity-'))
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: displayRoot })
      await writeFile(join(displayRoot, 'notes.txt'), 'untracked\n', 'utf8')
      const root = await realpath(displayRoot)
      const host = await createHost(root)

      const result = await new WorkspaceGitService(host, root).summary()

      assert.deepEqual(result, {
        state: 'available',
        branch: 'main',
        dirty: true,
        detached: false
      })

      if (transport === 'pure SSH SshHost') return

      await execFileAsync('git', ['config', 'user.name', 'Phi Test'], { cwd: root })
      await execFileAsync('git', ['config', 'user.email', 'phi@example.invalid'], { cwd: root })
      await execFileAsync('git', ['add', 'notes.txt'], { cwd: root })
      await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root })
      await execFileAsync('git', ['checkout', '--detach'], { cwd: root })
      const headOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
      ).stdout.trim()

      assert.deepEqual(await new WorkspaceGitService(host, root).summary(), {
        state: 'available',
        branch: headOid.slice(0, 7),
        dirty: false,
        detached: true,
        headOid
      })
    } finally {
      await rm(displayRoot, { recursive: true, force: true })
    }
  })
}

test.todo('pure SSH clean summaries require WorkspaceHost spooling outside the project root')
