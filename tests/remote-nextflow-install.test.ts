import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteNextflowEnvironmentCommand,
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

test('managed Nextflow command creates a Phi-owned environment with Java 17+', () => {
  const command = buildRemoteNextflowEnvironmentCommand({
    micromambaPath: '/srv/phi/runtime/bin/micromamba/2.9.0-0/micromamba',
    runtimeRoot: '/srv/phi/runtime',
    prefix: '/srv/phi/runtime/envs/phi-nextflow'
  })

  assert.match(command, /micromamba/)
  assert.match(command, /create/)
  assert.match(command, /\/srv\/phi\/runtime\/envs\/phi-nextflow/)
  assert.match(command, /nextflow/)
  assert.match(command, /openjdk>=17/)
  assert.doesNotMatch(command, /get\.nextflow\.io|curl|\.local\/bin/)
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

test('Nextflow installer creates and verifies the Phi-managed environment', async () => {
  let call = 0
  const h = await fixture(async () => {
    call += 1
    if (call === 1) return { ...ok(), code: 1 }
    return ok()
  })
  try {
    const result = await installRemoteNextflow(h.hostProfileId, {
      agentDir: h.agentDir,
      micromambaVersion: '2.9.0-0',
      resolveRuntimeRoot: async () => '/srv/phi/runtime',
      connectImpl: async (config) => {
        assert.equal(config.host, 'cluster-a')
        assert.equal(config.execTimeoutMs, 600_000)
        return h.session
      }
    })
    assert.deepEqual(result, {
      path: '/srv/phi/runtime/envs/phi-nextflow/bin/nextflow',
      alreadyInstalled: false
    })
    assert.equal(h.commands.length, 3)
    assert.match(h.commands[1], /micromamba.*create/)
    assert.match(h.commands[1], /openjdk>=17/)
    assert.doesNotMatch(h.commands.join('\n'), /get\.nextflow\.io|curl|\.local\/bin|\bsudo\b/)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})

test('a failed managed environment creation is reported without touching user conda', async () => {
  let call = 0
  const h = await fixture(async () => {
    call += 1
    return { ...ok(), code: 1 }
  })
  try {
    await assert.rejects(
      installRemoteNextflow(h.hostProfileId, {
        agentDir: h.agentDir,
        micromambaVersion: '2.9.0-0',
        resolveRuntimeRoot: async () => '/srv/phi/runtime',
        connectImpl: async () => h.session
      }),
      /Phi-managed Nextflow environment could not be created/
    )
    assert.equal(call, 2)
    assert.doesNotMatch(h.commands.join('\n'), /conda env|\.conda|\.local\/bin/)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})

test('an existing Phi-managed Nextflow environment is reused rather than overwritten', async () => {
  const h = await fixture(async () => ok())
  try {
    const result = await installRemoteNextflow(h.hostProfileId, {
      agentDir: h.agentDir,
      micromambaVersion: '2.9.0-0',
      resolveRuntimeRoot: async () => '/srv/phi/runtime',
      connectImpl: async () => h.session
    })
    assert.deepEqual(result, {
      path: '/srv/phi/runtime/envs/phi-nextflow/bin/nextflow',
      alreadyInstalled: true
    })
    assert.equal(h.commands.length, 1)
    assert.doesNotMatch(h.commands[0], /create/)
    assert.equal(h.closed(), true)
  } finally {
    h.cleanup()
  }
})
