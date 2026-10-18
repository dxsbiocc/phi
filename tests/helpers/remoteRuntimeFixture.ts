import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type {
  RemoteExecBoundedOptions,
  RemoteExecBoundedResult,
  RemoteExecResult
} from '../../src/main/agent/wrappers/remote-ssh-session'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import {
  remoteHelperReadyMarkerIdentity,
  remoteHelperReadyMarkerSha256,
  serializeRemoteHelperReadyMarker,
  type RemoteHelperInstallation
} from '../../src/main/agent/remote-helper-marker'
import type { RemoteRuntimeWorkspace } from '../../src/main/agent/remote-runtime/types'
import { createRemoteRuntimeInputExec } from '../../src/main/agent/remote-runtime/input-exec'
import {
  createLocalShellSession,
  installSetsidShim,
  type LocalShellSession
} from './localShellSession'

export interface RemoteRuntimeFixture {
  root: string
  projectRoot: string
  runtimeRoot: string
  localAnchor: string
  remoteHome: string
  /** PATH the fake server's commands inherit. */
  serverPath: string
  workspace: RemoteRuntimeWorkspace
  sessions: LocalShellSession[]
  connect(): Promise<LocalShellSession>
  cleanup(): void
}

const TEST_SKILL_MD = `---
name: remote-demo
description: Run a remote test script with bundled dependencies.
phi:
  environment: phi:python@1
  toolPrefix: remotedemo
  scripts:
    - name: json
      description: Return JSON from the remote project.
      run: [bash, ./scripts/json.sh]
      args:
        type: object
        additionalProperties: false
        required: [message]
        properties:
          message:
            type: string
      approval: read
    - name: write
      description: Write text to a remote project path.
      run: [bash, ./scripts/write.sh]
      args:
        type: object
        additionalProperties: false
        required: [output, content]
        properties:
          output:
            type: string
            format: project-path
          content:
            type: string
          input:
            type: string
            format: input-path
      approval: read
---
Remote test skill.
`

/**
 * The fake server is this machine, and the server-Jupyter lookup checks PATH. Drop PATH entries
 * that hold a `jupyter` executable so a developer's own Jupyter is never picked as the server's.
 */
function pathWithoutHostJupyter(path: string | undefined): string {
  return (path ?? '')
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, 'jupyter')))
    .join(delimiter)
}

export function createRemoteRuntimeFixture(): RemoteRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-runtime-'))
  const projectPath = join(root, 'server-project')
  const runtimePath = join(root, 'server-runtime')
  const localAnchor = join(root, 'local-anchor')
  const remoteHome = join(root, 'remote-home')
  for (const path of [projectPath, runtimePath, localAnchor, remoteHome]) mkdirSync(path)
  writeFileSync(join(remoteHome, '.condarc'), 'channels:\n  - private-channel\nssl_verify: false\n')
  const projectRoot = realpathSync(projectPath)
  const runtimeRoot = realpathSync(runtimePath)
  const sessions: LocalShellSession[] = []
  const shimDir = join(root, 'setsid-shim')
  mkdirSync(shimDir)
  const restoreSetsid = installSetsidShim(shimDir)
  const inheritedEnv = {
    ...process.env,
    PATH: pathWithoutHostJupyter(process.env.PATH),
    HOME: remoteHome,
    CONDA_DEFAULT_ENV: 'private',
    CONDA_PREFIX: join(remoteHome, 'miniconda3'),
    XDG_CACHE_HOME: join(remoteHome, '.cache'),
    MAMBA_ROOT_PREFIX: join(remoteHome, 'private-mamba'),
    MAMBA_PKGS_DIRS: join(remoteHome, 'private-pkgs')
  }
  // Raw stdio channels read PATH when they spawn, so shims installed after this fixture still apply.
  const channelEnv = (): NodeJS.ProcessEnv => ({
    ...inheritedEnv,
    PATH: pathWithoutHostJupyter(process.env.PATH)
  })
  const connect = async (): Promise<LocalShellSession> => {
    const session = createLocalShellSession(runtimeRoot, { env: channelEnv })
    installExecEnvironment(session, inheritedEnv)
    session.execWithInput = (command, input) => execWithInput(session, command, input, inheritedEnv)
    session.execBounded = (command, options) => execBounded(session, command, options, inheritedEnv)
    sessions.push(session)
    return session
  }
  const runtimeHost = new SshHost({
    remoteRoot: runtimeRoot,
    canonicalRoot: runtimeRoot,
    connect
  })
  const helperRoot = join(runtimeRoot, 'test-helper')
  const helperDirectory = join(helperRoot, '0.1.0')
  const helperPath = join(helperDirectory, 'phi-helper')
  mkdirSync(helperDirectory, { recursive: true, mode: 0o700 })
  chmodSync(helperRoot, 0o700)
  chmodSync(helperDirectory, 0o700)
  const guardScript = join(process.cwd(), 'tests/helpers/projectPluginGuardCli.ts')
  const guardCommand = process.execPath.includes('bun')
    ? `'${process.execPath}' '${guardScript}'`
    : `'${process.execPath}' --import '${join(process.cwd(), 'scripts/test-loader.mjs')}' '${guardScript}'`
  writeFileSync(helperPath, `#!/bin/sh\nexec ${guardCommand} "$@"\n`, { mode: 0o700 })
  const helperIdentity = remoteHelperReadyMarkerIdentity({
    version: '0.1.0',
    sha256: createHash('sha256').update(readFileSync(helperPath)).digest('hex')
  })
  const readyMarkerPath = join(helperDirectory, '.phi-ready.json')
  writeFileSync(readyMarkerPath, serializeRemoteHelperReadyMarker(helperIdentity), { mode: 0o600 })
  const helperInstallation: RemoteHelperInstallation = {
    managedRoot: helperRoot,
    remotePath: helperPath,
    remoteDirectory: helperDirectory,
    readyMarkerPath,
    markerIdentity: helperIdentity,
    readyMarkerSha256: remoteHelperReadyMarkerSha256(helperIdentity)
  }
  runtimeHost.managedRemoteHelper = () => helperInstallation
  runtimeHost.ensureManagedRemoteHelper = async () => helperInstallation
  const workspace: RemoteRuntimeWorkspace = {
    projectHost: sshHost(projectRoot, sessions, inheritedEnv, channelEnv),
    runtimeHost,
    projectRoot,
    runtimeRoot,
    execWithInput: createRemoteRuntimeInputExec(connect)
  }
  return {
    root,
    projectRoot,
    runtimeRoot,
    localAnchor,
    remoteHome,
    serverPath: inheritedEnv.PATH,
    workspace,
    sessions,
    connect,
    cleanup: () => {
      restoreSetsid()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function sshHost(
  root: string,
  sessions: LocalShellSession[],
  inheritedEnv: NodeJS.ProcessEnv,
  channelEnv: () => NodeJS.ProcessEnv
): SshHost {
  return new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => {
      const session = createLocalShellSession(root, { env: channelEnv })
      installExecEnvironment(session, inheritedEnv)
      session.execWithInput = (command, input) =>
        execWithInput(session, command, input, inheritedEnv)
      session.execBounded = (command, options) =>
        execBounded(session, command, options, inheritedEnv)
      sessions.push(session)
      return session
    }
  })
}

function installExecEnvironment(session: LocalShellSession, env: NodeJS.ProcessEnv): void {
  const fallback = session.exec.bind(session)
  session.exec = (command) => {
    if (/^ps -ww -o args= -p [1-9][0-9]*$/u.test(command)) return fallback(command)
    session.commands.push(command)
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    })
  }
}

function execBounded(
  session: LocalShellSession,
  command: string,
  options: RemoteExecBoundedOptions,
  env: NodeJS.ProcessEnv
): Promise<RemoteExecBoundedResult> {
  session.commands.push(command)
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stdoutTruncated = false
    let stderrTruncated = false
    const append = (current: Buffer, chunk: Buffer): [Buffer, boolean] => {
      const available = Math.max(0, options.maxOutputBytes - current.length)
      return [Buffer.concat([current, chunk.subarray(0, available)]), chunk.length > available]
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const next = append(stdout, chunk)
      stdout = next[0]
      stdoutTruncated ||= next[1]
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = append(stderr, chunk)
      stderr = next[0]
      stderrTruncated ||= next[1]
    })
    const stop = (): void => {
      child.kill('SIGTERM')
    }
    const timer = setTimeout(stop, options.timeoutMs)
    timer.unref()
    options.signal?.addEventListener('abort', stop, { once: true })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
        code,
        signal
      })
    })
  })
}

function execWithInput(
  session: LocalShellSession,
  command: string,
  input: string,
  env: NodeJS.ProcessEnv
): Promise<RemoteExecResult> {
  session.commands.push(command)
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal
      })
    })
    // A script that exits before reading its input must not raise EPIPE, as in the real session.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

export function installFakeMicromamba(
  fixture: RemoteRuntimeFixture,
  version = 'test',
  mode: 'ok' | 'offline' | 'cached-offline' | 'silent' = 'ok'
): string {
  const versionDir = join(fixture.runtimeRoot, 'bin', `micromamba-${version}`)
  mkdirSync(versionDir, { recursive: true, mode: 0o755 })
  chmodSync(versionDir, 0o755)
  const path = join(versionDir, 'micromamba')
  const executableCheck = `phi_executable=$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || printf '%s\\n' "$0")
if [ "$(basename "$phi_executable")" != micromamba ]; then
  printf 'Error unknown MAMBA_EXE: "%s", filename must be mamba or micromamba\\n' "$phi_executable" >&2
  exit 1
fi
`
  const systemRipgrep = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, 'rg'))
    .find((candidate) => existsSync(candidate))
  const runSystemRipgrep = systemRipgrep
    ? `exec '${systemRipgrep.replaceAll("'", `'\\''`)}' "$@"`
    : 'exit 0'
  const fakeRipgrep = `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  printf 'ripgrep 14.1.1\\n'
  exit 0
fi
${runSystemRipgrep}
`
  const source = `#!/bin/sh
set -eu
${executableCheck}phi_root=\${MAMBA_ROOT_PREFIX:?}
phi_calls="$phi_root/micromamba-invocations.log"
{
  printf 'B\\0'
  env | sort | while IFS= read -r phi_env; do printf 'E%s\\0' "$phi_env"; done
  for phi_arg in "$@"; do printf 'A%s\\0' "$phi_arg"; done
  printf 'Z\\0'
} >> "$phi_calls"
if env | grep -q '^CONDA_'; then exit 91; fi
if env | grep '^MAMBA_' | grep -Ev '^(MAMBA_ROOT_PREFIX|MAMBA_PKGS_DIRS)=' >/dev/null; then exit 92; fi
[ "\${MAMBA_PKGS_DIRS:-}" = "$phi_root/pkgs" ] || exit 93
[ "\${XDG_CACHE_HOME:-}" = "$phi_root/cache" ] || exit 96
if [ "\${1:-}" = --version ]; then echo 2.9.0; exit 0; fi
if [ "\${1:-}" = --rc-file ]; then [ "\${2:-}" = /dev/null ] || exit 94; shift 2; fi
command_name=\${1:-}
shift || :
phi_no_rc=0
phi_offline=0
for phi_arg in "$@"; do
  [ "$phi_arg" = --no-rc ] && phi_no_rc=1
  [ "$phi_arg" = --offline ] && phi_offline=1
done
printf '%s|root=%s\\n' "$command_name $*" "\${MAMBA_ROOT_PREFIX:-}" >> "$phi_root/micromamba-calls.log"
if [ "$command_name" = create ]; then
  [ "$phi_no_rc" -eq 1 ] || exit 95
  if [ '${mode}' = silent ]; then exit 1; fi
  if [ '${mode}' = offline ] || [ '${mode}' = cached-offline ]; then
    if [ "$phi_offline" -eq 0 ]; then
      echo "Could not resolve host: conda.anaconda.org" >&2
      exit 7
    fi
    if [ '${mode}' = offline ]; then
      echo "Specified package cache does not contain requested packages" >&2
      exit 8
    fi
  fi
  prefix=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -p ]; then prefix=$2; shift 2; continue; fi
    shift
  done
  mkdir -p "$prefix/conda-meta" "$prefix/bin"
  : > "$prefix/conda-meta/history"
  cat > "$prefix/bin/rg" <<'PHI_FAKE_RG'
${fakeRipgrep}PHI_FAKE_RG
  chmod 755 "$prefix/bin/rg"
  exit 0
fi
if [ "$command_name" = run ]; then
  [ "$1" = -p ]
  shift 2
  exec "$@"
fi
exit 9
`
  writeFileSync(path, source)
  chmodSync(path, 0o755)
  return path
}

export interface FakeMicromambaInvocation {
  env: Readonly<Record<string, string>>
  argv: readonly string[]
}

export function readFakeMicromambaInvocations(
  fixture: RemoteRuntimeFixture
): FakeMicromambaInvocation[] {
  const fields = readFileSync(join(fixture.runtimeRoot, 'micromamba-invocations.log'), 'utf8')
    .split('\0')
    .filter(Boolean)
  const calls: FakeMicromambaInvocation[] = []
  let env: Record<string, string> = {}
  let argv: string[] = []
  for (const field of fields) {
    if (field === 'B') {
      env = {}
      argv = []
    } else if (field === 'Z') calls.push({ env, argv })
    else if (field.startsWith('A')) argv.push(field.slice(1))
    else if (field.startsWith('E')) {
      const entry = field.slice(1)
      const separator = entry.indexOf('=')
      if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
  }
  return calls
}

export function writeTestSkill(
  fixture: RemoteRuntimeFixture,
  options: { sleeper?: boolean; noisy?: boolean } = {}
): { dir: string; name: string; filePath: string } {
  const dir = join(fixture.root, 'global-skills', 'remote-demo')
  const scripts = join(dir, 'scripts')
  mkdirSync(join(scripts, 'data'), { recursive: true })
  const body = options.sleeper
    ? '#!/bin/sh\necho $$ > started.pid\nsleep 30\n'
    : options.noisy
      ? '#!/bin/sh\ni=0; while [ "$i" -lt 400 ]; do printf 0123456789; printf abcdefghij >&2; i=$((i+1)); done\n'
      : '#!/bin/sh\nprintf "%s|%s|%s" "$PWD" "$1" "$(cat "$(dirname "$0")/data/value.txt")"\n'
  const filePath = join(dir, 'SKILL.md')
  writeFileSync(filePath, TEST_SKILL_MD)
  writeFileSync(join(scripts, 'run.sh'), body)
  writeFileSync(
    join(scripts, 'json.sh'),
    options.sleeper
      ? '#!/bin/sh\necho $$ > dynamic-started.pid\nsleep 30\n'
      : '#!/bin/sh\nprintf \'{"message":"%s","cwd":"%s"}\' "$2" "$PWD"\n'
  )
  writeFileSync(
    join(scripts, 'write.sh'),
    '#!/bin/sh\nprintf %s "$4" > "$2"\nprintf \'{"written":"%s","input":"%s"}\' "$2" "${6:-}"\n'
  )
  writeFileSync(join(scripts, 'data', 'value.txt'), 'dependency')
  chmodSync(join(scripts, 'run.sh'), 0o755)
  chmodSync(join(scripts, 'json.sh'), 0o755)
  chmodSync(join(scripts, 'write.sh'), 0o755)
  return { dir, name: 'remote-demo', filePath }
}
