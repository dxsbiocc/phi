import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteNextflowInstallScript,
  installRemoteNextflow
} from '../src/main/agent/remote-nextflow-install'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

const ok = (stdout = '', stderr = ''): RemoteExecResult => ({
  stdout,
  stderr,
  code: 0,
  signal: null
})

async function fixture(execute: (command: string) => Promise<RemoteExecResult>): Promise<{
  hostProfileId: string
  agentDir: string
  session: RemoteSshSession
  commands: string[]
  closed: () => boolean
  cleanup: () => void
}> {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-nextflow-install-'))
  const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster-a' }, agentDir)
  const commands: string[] = []
  let didClose = false
  const unused = async (): Promise<never> => {
    throw new Error('installer must only execute remote shell commands')
  }
  return {
    hostProfileId: host.id,
    agentDir,
    session: {
      exec: async (command) => {
        commands.push(command)
        return execute(command)
      },
      readTextFile: unused,
      writeTextFile: unused,
      mkdirp: unused,
      exists: unused,
      uploadFile: unused,
      close: async () => {
        didClose = true
      }
    },
    commands,
    closed: () => didClose,
    cleanup: () => rmSync(agentDir, { recursive: true, force: true })
  }
}

test('Nextflow installer uses only the SSH account home and the official installer', async () => {
  let call = 0
  const h = await fixture(async () => {
    call += 1
    if (call === 1) return ok('', 'openjdk version "17.0.15" 2026-01-01')
    if (call === 2) return ok()
    return ok('__PHI_NEXTFLOW_INSTALLED__:/home/scientist/.local/bin/nextflow\n')
  })
  try {
    const result = await installRemoteNextflow(h.hostProfileId, {
      agentDir: h.agentDir,
      connectImpl: async (config) => {
        assert.equal(config.host, 'cluster-a')
        assert.equal(config.execTimeoutMs, 300_000)
        return h.session
      }
    })
    assert.deepEqual(result, {
      path: '/home/scientist/.local/bin/nextflow',
      alreadyInstalled: false
    })
    assert.equal(h.commands.length, 3)
    assert.match(h.commands[2], /get\.nextflow\.io/)
    assert.match(h.commands[2], /\.local\/bin\/nextflow/)
    assert.doesNotMatch(h.commands[2], /\bsudo\b/)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})

test('missing or old Java blocks automatic installation without a download', async () => {
  const h = await fixture(async () => ok('', 'openjdk version "11.0.25"'))
  try {
    await assert.rejects(
      installRemoteNextflow(h.hostProfileId, {
        agentDir: h.agentDir,
        connectImpl: async () => h.session
      }),
      /Java 17/
    )
    assert.equal(h.commands.length, 1)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})

test('an existing Nextflow executable is reused rather than overwritten', async () => {
  let call = 0
  const h = await fixture(async () => {
    call += 1
    if (call === 1) return ok('', 'openjdk version "21.0.2"')
    if (call === 2) return ok()
    return ok('__PHI_NEXTFLOW_EXISTING__:/home/scientist/.local/bin/nextflow\n')
  })
  try {
    const result = await installRemoteNextflow(h.hostProfileId, {
      agentDir: h.agentDir,
      connectImpl: async () => h.session
    })
    assert.equal(result.alreadyInstalled, true)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})

test('the fixed install script works in a personal directory without contacting the network', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-nextflow-script-'))
  const stubBin = join(root, 'bin')
  mkdirSync(stubBin)
  writeFileSync(
    join(stubBin, 'curl'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi
done
cat > "$output" <<'INSTALLER'
#!/bin/sh
cat > nextflow <<'NEXTFLOW'
#!/bin/sh
exit 0
NEXTFLOW
INSTALLER
`,
    { mode: 0o755 }
  )
  const env = {
    ...process.env,
    HOME: root,
    TMPDIR: root,
    PATH: `${stubBin}:/usr/bin:/bin`
  }
  try {
    const script = buildRemoteNextflowInstallScript()
    const first = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /__PHI_NEXTFLOW_INSTALLED__:/)
    assert.equal(existsSync(join(root, '.local/bin/nextflow')), true)
    const second = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /__PHI_NEXTFLOW_EXISTING__:/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
