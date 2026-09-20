import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project, ProjectRemoteConnection } from '../src/main/agent/projects'
import {
  resolveProjectRemoteSubmitOptions,
  resolveProjectRemoteTarget,
  resolveRemoteConnectionConfig
} from '../src/main/agent/wrappers/remote-connection-resolver'

function withAgentDir<T>(callback: (agentDir: string, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-connection-resolver-'))
  try {
    return callback(join(root, '.phi-home'), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeKeyFile(root: string, content = 'FAKE-PRIVATE-KEY'): string {
  const path = join(root, 'id_ed25519')
  writeFileSync(path, content, 'utf-8')
  return path
}

const BASE_CONNECTION: Omit<ProjectRemoteConnection, 'privateKeyPath'> = {
  id: 'conn1',
  label: 'Lab HPC',
  host: 'lab-hpc.example.edu',
  username: 'agent'
}

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj1',
    name: 'demo',
    workingDirectory: '/tmp/demo',
    workingDirectoryRealPath: '/tmp/demo',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

test('resolveRemoteConnectionConfig reads the key file and omits passphrase when the key does not need one', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const connection: ProjectRemoteConnection = { ...BASE_CONNECTION, privateKeyPath }

    const config = resolveRemoteConnectionConfig(connection, agentDir)

    assert.equal(config.host, 'lab-hpc.example.edu')
    assert.equal(config.username, 'agent')
    assert.equal(config.privateKey, 'FAKE-PRIVATE-KEY')
    assert.equal(config.passphrase, undefined)
  })
})

test('resolveRemoteConnectionConfig throws a specific error when the key file is missing', () => {
  withAgentDir((agentDir, root) => {
    const connection: ProjectRemoteConnection = {
      ...BASE_CONNECTION,
      privateKeyPath: join(root, 'does-not-exist')
    }

    assert.throws(() => resolveRemoteConnectionConfig(connection, agentDir), /私钥文件/)
  })
})

test('resolveRemoteConnectionConfig throws a specific error when a passphrase is required but not available', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const connection: ProjectRemoteConnection = {
      ...BASE_CONNECTION,
      privateKeyPath,
      hasPassphrase: true
    }

    // No safeStorage/keychain access under the plain `node --test` runner —
    // the passphrase can never be found, same as a real keychain-locked host.
    assert.throws(() => resolveRemoteConnectionConfig(connection, agentDir), /密钥口令/)
  })
})

test('resolveProjectRemoteSubmitOptions returns undefined when the project has no remoteWorkspaceRoot', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const project = baseProject({
      remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath }],
      defaultRemoteConnectionId: 'conn1'
      // remoteWorkspaceRoot intentionally omitted
    })

    assert.equal(resolveProjectRemoteSubmitOptions(project, agentDir), undefined)
  })
})

test('resolveProjectRemoteSubmitOptions returns undefined when defaultRemoteConnectionId does not match any saved connection', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const project = baseProject({
      remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath }],
      defaultRemoteConnectionId: 'some-other-id',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    assert.equal(resolveProjectRemoteSubmitOptions(project, agentDir), undefined)
  })
})

test('resolveProjectRemoteSubmitOptions resolves the default connection when everything is configured', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const project = baseProject({
      remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath }],
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const resolved = resolveProjectRemoteSubmitOptions(project, agentDir)

    assert.ok(resolved)
    assert.equal(resolved?.remoteWorkspaceRoot, '/data/lab/.phi')
    assert.equal(resolved?.connection.host, 'lab-hpc.example.edu')
  })
})

test('resolveProjectRemoteSubmitOptions still throws (does not swallow) when the matched connection is broken', () => {
  withAgentDir((agentDir, root) => {
    const project = baseProject({
      remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath: join(root, 'missing-key') }],
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    assert.throws(() => resolveProjectRemoteSubmitOptions(project, agentDir), /私钥文件/)
  })
})

// ── resolveProjectRemoteTarget ────────────────────────────────────────────

test('resolveProjectRemoteTarget returns the default connection with its HPC settings', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const hpc = { scheduler: 'slurm' as const, queue: 'cpu', runtime: 'singularity' as const }
    const project = baseProject({
      remoteWorkspaceRoot: '/data/lab/.phi',
      defaultRemoteConnectionId: 'conn1',
      remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath, hpc }]
    })

    const resolved = resolveProjectRemoteTarget(project, undefined, agentDir)
    assert.ok('target' in resolved)
    assert.equal(resolved.target.connection.host, 'lab-hpc.example.edu')
    assert.equal(resolved.target.workspaceRoot, '/data/lab/.phi')
    assert.deepEqual(resolved.target.hpc, hpc)
    assert.equal(resolved.connectionId, 'conn1')
    assert.equal(resolved.projectId, 'proj1')
  })
})

test('resolveProjectRemoteTarget can pick a specific saved connection, for resuming a run', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const project = baseProject({
      remoteWorkspaceRoot: '/w',
      defaultRemoteConnectionId: 'conn1',
      remoteConnections: [
        { ...BASE_CONNECTION, privateKeyPath, hpc: { scheduler: 'slurm' } },
        {
          ...BASE_CONNECTION,
          id: 'conn2',
          host: 'other.example.edu',
          privateKeyPath,
          hpc: { scheduler: 'local' }
        }
      ]
    })
    const resolved = resolveProjectRemoteTarget(project, 'conn2', agentDir)
    assert.ok('target' in resolved)
    assert.equal(resolved.target.connection.host, 'other.example.edu')
  })
})

test('resolveProjectRemoteTarget explains each way a project can lack a usable remote', () => {
  withAgentDir((agentDir, root) => {
    const privateKeyPath = writeKeyFile(root)
    const noRoot = resolveProjectRemoteTarget(
      baseProject({
        defaultRemoteConnectionId: 'conn1',
        remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath }]
      }),
      undefined,
      agentDir
    )
    assert.ok('reason' in noRoot)
    assert.match(noRoot.reason, /远程工作目录|remoteWorkspaceRoot|workspace/i)

    const noConnection = resolveProjectRemoteTarget(
      baseProject({ remoteWorkspaceRoot: '/w' }),
      undefined,
      agentDir
    )
    assert.ok('reason' in noConnection)
    assert.match(noConnection.reason, /连接|connection/i)

    const missingKey = resolveProjectRemoteTarget(
      baseProject({
        remoteWorkspaceRoot: '/w',
        defaultRemoteConnectionId: 'conn1',
        remoteConnections: [
          { ...BASE_CONNECTION, privateKeyPath: join(root, 'gone'), hpc: { scheduler: 'slurm' } }
        ]
      }),
      undefined,
      agentDir
    )
    assert.ok('reason' in missingKey)
    assert.match(missingKey.reason, /私钥/)

    const noHpc = resolveProjectRemoteTarget(
      baseProject({
        remoteWorkspaceRoot: '/w',
        defaultRemoteConnectionId: 'conn1',
        remoteConnections: [{ ...BASE_CONNECTION, privateKeyPath }]
      }),
      undefined,
      agentDir
    )
    assert.ok('reason' in noHpc)
    assert.match(noHpc.reason, /运行方式/)

    const noProject = resolveProjectRemoteTarget(undefined, undefined, agentDir)
    assert.ok('reason' in noProject)
  })
})
