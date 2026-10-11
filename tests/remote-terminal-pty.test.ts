import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { buildTerminalEnv } from '../src/main/terminal/terminal-env'
import { TerminalHost } from '../src/main/terminal/terminal-host'
import {
  buildRemoteTerminalCommand,
  buildSshTerminalLaunch
} from '../src/main/terminal/terminal-launch'

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8')
  chmodSync(path, 0o700)
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function activeChildHandles(): unknown[] {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles
  return (
    getActiveHandles?.().filter((handle) => {
      const child = handle as {
        constructor?: { name?: string }
        exitCode?: number | null
        signalCode?: string | null
      }
      return (
        child.constructor?.name === 'ChildProcess' &&
        child.exitCode === null &&
        child.signalCode === null
      )
    }) ?? []
  )
}

interface RemotePtyFixture {
  root: string
  argvFile: string
  childFile: string
  fakeShell: string
  launch: ReturnType<typeof buildSshTerminalLaunch>
  handlesBefore: Set<unknown>
  host?: TerminalHost
  rootPid: number
  childPid: number
}

function createFixture(): RemotePtyFixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-terminal-'))
  const remoteRoot = join(root, "- project 'quote' $cash `tick` line\nbreak")
  const argvFile = join(root, 'ssh-argv.bin')
  const childFile = join(remoteRoot, 'child.pid')
  const fakeSsh = join(root, 'ssh')
  const fakeShell = join(root, 'remote-shell')
  mkdirSync(remoteRoot)
  executable(fakeSsh, fakeSshSource(argvFile))
  executable(fakeShell, fakeShellSource())
  return {
    root,
    argvFile,
    childFile,
    fakeShell,
    launch: buildSshTerminalLaunch({
      connection: { host: 'fake-cluster', user: 'tester', port: 2222 },
      remoteRoot,
      localCwd: root,
      hostLabel: 'fake-cluster',
      sshExecutable: fakeSsh
    }),
    handlesBefore: new Set(activeChildHandles()),
    rootPid: 0,
    childPid: 0
  }
}

function fakeSshSource(argvFile: string): string {
  return `#!/bin/sh
: > ${JSON.stringify(argvFile)}
last=''
for arg in "$@"; do
  printf '%s\\0' "$arg" >> ${JSON.stringify(argvFile)}
  last=$arg
done
exec /bin/sh -c "$last"
`
}

function fakeShellSource(): string {
  return `#!/bin/sh
sleep 300 &
child=$!
printf '%s\\n' "$child" > "$PWD/child.pid"
printf 'PHI_REMOTE_READY\\n'
printf 'PHI_ENV:%s:%s:%s\\n' "\${TERM:-unset}" "\${CONDA_PREFIX:-unset}" "\${OPENAI_API_KEY:-unset}"
trap 'set -- $(stty size); printf "PHI_SIZE:%s %s\\n" "$1" "$2"' WINCH
wait "$child"
`
}

async function exerciseFixture(fixture: RemotePtyFixture): Promise<void> {
  let output = ''
  fixture.host = new TerminalHost()
  fixture.host.subscribe((event) => {
    if (event.type === 'data') output += event.data
  })
  const created = await fixture.host.createTerminal({
    terminalId: 'remote-terminal-pty',
    application: fixture.launch.application,
    args: fixture.launch.args,
    cwd: fixture.launch.localCwd,
    env: buildTerminalEnv({
      HOME: fixture.root,
      USER: 'tester',
      LOGNAME: 'tester',
      SHELL: fixture.fakeShell,
      LANG: 'en_US.UTF-8',
      CONDA_PREFIX: '/must/not/leak',
      OPENAI_API_KEY: 'must-not-leak'
    }),
    cols: 80,
    rows: 24
  })
  fixture.rootPid = created.pid
  await fixture.host.setCredit(created.terminalId, 512 * 1024)
  await waitFor(() => output.includes('PHI_REMOTE_READY'), 'remote shell readiness')
  await waitFor(
    () => output.includes('PHI_ENV:xterm-256color:unset:unset'),
    'sanitized environment'
  )
  await waitFor(
    () =>
      existsSync(fixture.childFile) && readFileSync(fixture.childFile, 'utf8').trim().length > 0,
    'child pid'
  )
  fixture.childPid = Number(readFileSync(fixture.childFile, 'utf8').trim())
  const argv = readFileSync(fixture.argvFile).toString('utf8').split('\0').slice(0, -1)
  assert.deepEqual(argv, fixture.launch.args)
  await fixture.host.resize(created.terminalId, 111, 37)
  await waitFor(() => output.includes('PHI_SIZE:37 111'), 'SIGWINCH dimensions')
  await fixture.host.close(created.terminalId, 'user')
  await waitFor(
    () => !running(fixture.rootPid) && !running(fixture.childPid),
    'ssh process group exit'
  )
}

async function cleanupFixture(fixture: RemotePtyFixture): Promise<void> {
  await fixture.host?.dispose().catch(() => undefined)
  for (const pid of [fixture.childPid, fixture.rootPid]) {
    if (pid > 0 && running(pid)) process.kill(pid, 'SIGKILL')
  }
  rmSync(fixture.root, { recursive: true, force: true })
}

test(
  'fake ssh PTY preserves argv, resizes, and kills the local ssh process group',
  { skip: process.platform !== 'darwin', timeout: 20_000 },
  async () => {
    const fixture = createFixture()
    try {
      await exerciseFixture(fixture)
      await fixture.host?.dispose()
      fixture.host = undefined
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(
        activeChildHandles().filter((handle) => !fixture.handlesBefore.has(handle)),
        []
      )
    } finally {
      await cleanupFixture(fixture)
    }
  }
)

test('missing remote root reports the explicit Chinese error instead of opening home', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-terminal-missing-'))
  try {
    const missing = join(root, 'missing project')
    const result = spawnSync('/bin/sh', ['-c', buildRemoteTerminalCommand(missing)], {
      encoding: 'utf8',
      env: { ...process.env, SHELL: '/bin/sh' }
    })
    assert.equal(result.status, 72)
    assert.match(result.stderr, /远程项目目录不存在或无法进入，已停止启动终端。/u)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
