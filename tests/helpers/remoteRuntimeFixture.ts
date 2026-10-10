import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RemoteExecResult } from '../../src/main/agent/wrappers/remote-ssh-session'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import type { RemoteRuntimeWorkspace } from '../../src/main/agent/remote-runtime/types'
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
  workspace: RemoteRuntimeWorkspace
  sessions: LocalShellSession[]
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

export function createRemoteRuntimeFixture(): RemoteRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-runtime-'))
  const projectPath = join(root, 'server-project')
  const runtimePath = join(root, 'server-runtime')
  const localAnchor = join(root, 'local-anchor')
  for (const path of [projectPath, runtimePath, localAnchor]) mkdirSync(path)
  const projectRoot = realpathSync(projectPath)
  const runtimeRoot = realpathSync(runtimePath)
  const sessions: LocalShellSession[] = []
  const shimDir = join(root, 'setsid-shim')
  mkdirSync(shimDir)
  const restoreSetsid = installSetsidShim(shimDir)
  const workspace: RemoteRuntimeWorkspace = {
    projectHost: sshHost(projectRoot, sessions),
    runtimeHost: sshHost(runtimeRoot, sessions),
    projectRoot,
    runtimeRoot
  }
  return {
    root,
    projectRoot,
    runtimeRoot,
    localAnchor,
    workspace,
    sessions,
    cleanup: () => {
      restoreSetsid()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function sshHost(root: string, sessions: LocalShellSession[]): SshHost {
  return new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => {
      const session = createLocalShellSession(root)
      session.execWithInput = (command, input) => execWithInput(session, command, input)
      sessions.push(session)
      return session
    }
  })
}

function execWithInput(
  session: LocalShellSession,
  command: string,
  input: string
): Promise<RemoteExecResult> {
  session.commands.push(command)
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    child.stdin.end(input)
  })
}

export function installFakeMicromamba(
  fixture: RemoteRuntimeFixture,
  version = 'test',
  mode: 'ok' | 'offline' = 'ok'
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
  const source =
    mode === 'offline'
      ? `#!/bin/sh
${executableCheck}echo "Could not resolve host: conda.anaconda.org" >&2
exit 7
`
      : `#!/bin/sh
set -eu
${executableCheck}command_name=$1
shift
phi_root=\${MAMBA_ROOT_PREFIX:?}
printf '%s|root=%s\\n' "$command_name $*" "\${MAMBA_ROOT_PREFIX:-}" >> "$phi_root/micromamba-calls.log"
if [ "$command_name" = create ]; then
  prefix=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -p ]; then prefix=$2; shift 2; continue; fi
    shift
  done
  mkdir -p "$prefix/conda-meta" "$prefix/bin"
  : > "$prefix/conda-meta/history"
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
