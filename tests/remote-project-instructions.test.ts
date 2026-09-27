import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ProjectLocation } from '../src/shared/projectLocation'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import {
  buildRemoteInstructionReadCommand,
  loadRemoteProjectInstructions
} from '../src/main/agent/remote-project-instructions'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

type SshLocation = Extract<ProjectLocation, { kind: 'ssh' }>

function fixture(): {
  agentDir: string
  root: string
  location: SshLocation
  commands: string[]
  connectImpl: () => Promise<RemoteSshSession>
  closed: () => number
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-instructions-'))
  const agentDir = join(base, 'phi')
  const root = join(base, 'remote project')
  mkdirSync(root)
  const profile = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster-one' }, agentDir)
  const location: SshLocation = {
    kind: 'ssh',
    hostProfileId: profile.id,
    remoteRoot: root,
    canonicalRoot: realpathSync(root)
  }
  const commands: string[] = []
  let closeCount = 0
  return {
    agentDir,
    root,
    location,
    commands,
    connectImpl: async () => ({
      exec: async (command) => {
        commands.push(command)
        const result = spawnSync('sh', ['-c', command], {
          encoding: 'utf-8',
          timeout: 3_000,
          maxBuffer: 128 * 1024
        })
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          code: result.status,
          signal: result.signal
        }
      },
      readTextFile: async () => {
        throw new Error('unbounded read must not be used')
      },
      writeTextFile: async () => {
        throw new Error('write must not be used')
      },
      mkdirp: async () => {
        throw new Error('write must not be used')
      },
      exists: async () => {
        throw new Error('extra probe must not be used')
      },
      uploadFile: async () => {
        throw new Error('upload must not be used')
      },
      close: async () => {
        closeCount += 1
      }
    }),
    closed: () => closeCount,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

test('remote root instructions carry SSH sources and refresh for a new session', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'AGENTS.md'), 'remote rules v1\n')
    writeFileSync(join(sample.root, 'CLAUDE.md'), 'remote assistant rules\n')
    writeFileSync(join(sample.root, '.env'), 'SECRET=never-read\n')
    const anchor = join(sample.agentDir, 'remote-project-anchors', 'project-a')
    mkdirSync(anchor, { recursive: true })
    writeFileSync(join(anchor, 'AGENTS.md'), 'local anchor rules must be ignored\n')

    const first = await loadRemoteProjectInstructions(sample.location, sample)
    assert.deepEqual(
      first.map(({ path, content }) => ({ path, content })),
      [
        {
          path: `ssh://cluster-one${join(sample.root, 'AGENTS.md')}`,
          content: 'remote rules v1\n'
        },
        {
          path: `ssh://cluster-one${join(sample.root, 'CLAUDE.md')}`,
          content: 'remote assistant rules\n'
        }
      ]
    )
    writeFileSync(join(sample.root, 'AGENTS.md'), 'remote rules v2\n')
    const next = await loadRemoteProjectInstructions(sample.location, sample)
    assert.equal(next[0]?.content, 'remote rules v2\n')
    assert.equal(sample.closed(), 2)
    assert.equal(sample.commands.length, 6)
    assert.equal(
      sample.commands.some((command) => command.includes('.env')),
      false
    )
    assert.equal(JSON.stringify(next).includes('local anchor rules'), false)
  } finally {
    sample.cleanup()
  }
})

test('instruction reads reject symlinks, oversized files, and changed project roots', async () => {
  const sample = fixture()
  try {
    const outside = join(sample.agentDir, 'outside.md')
    writeFileSync(outside, 'outside secret\n')
    symlinkSync(outside, join(sample.root, 'AGENTS.md'))
    await assert.rejects(loadRemoteProjectInstructions(sample.location, sample), /AGENTS.md/)
    rmSync(join(sample.root, 'AGENTS.md'))
    writeFileSync(join(sample.root, 'AGENTS.md'), 'a'.repeat(64 * 1024 + 1))
    await assert.rejects(loadRemoteProjectInstructions(sample.location, sample), /AGENTS.md/)
    rmSync(join(sample.root, 'AGENTS.md'))
    writeFileSync(join(sample.root, 'AGENTS.md'), 'safe\n')
    await assert.rejects(
      loadRemoteProjectInstructions(
        { ...sample.location, canonicalRoot: '/different/root' },
        sample
      ),
      /AGENTS.md/
    )
    assert.equal(sample.closed(), 3)
  } finally {
    sample.cleanup()
  }
})

test('missing SSH profile and connection failure never fall back to local instructions', async () => {
  const sample = fixture()
  try {
    await assert.rejects(
      loadRemoteProjectInstructions({ ...sample.location, hostProfileId: 'missing' }, sample),
      /服务器档案不可用/
    )
    await assert.rejects(
      loadRemoteProjectInstructions(sample.location, {
        agentDir: sample.agentDir,
        connectImpl: async () => {
          throw new Error('SSH offline')
        }
      }),
      /SSH offline/
    )
    assert.deepEqual(sample.commands, [])
  } finally {
    sample.cleanup()
  }
})

test('the shell command quotes remote paths without interpolating instruction content', () => {
  const command = buildRemoteInstructionReadCommand(
    {
      kind: 'ssh',
      hostProfileId: 'host',
      remoteRoot: "/cluster/it's project",
      canonicalRoot: "/cluster/it's project"
    },
    'AGENTS.md'
  )
  assert.match(command, /bash -c/)
  assert.match(command, /AGENTS\.md/)
  assert.doesNotMatch(command, /\.env/)
})
