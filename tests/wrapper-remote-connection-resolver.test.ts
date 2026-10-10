import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project, ProjectRemoteConnection } from '../src/main/agent/projects'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { saveHostRemoteEnvironmentPaths } from '../src/main/agent/remote-environment-store'
import {
  resolveProjectRemoteSubmitOptions,
  resolveProjectRemoteTarget,
  resolveRemoteConnectionConfig
} from '../src/main/agent/wrappers/remote-connection-resolver'

function withAgentDir<T>(fn: (agentDir: string) => T): T {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-host-resolver-'))
  try {
    return fn(agentDir)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

function project(connection: ProjectRemoteConnection): Project {
  return {
    id: 'project-1',
    name: 'Project',
    location: { kind: 'local', path: '/project', realPath: '/project' },
    workingDirectory: '/project',
    workingDirectoryRealPath: '/project',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z',
    remoteConnections: [connection],
    defaultRemoteConnectionId: connection.id,
    remoteWorkspaceRoot: '/cluster/lab/.phi'
  }
}

test('remote connection carries a saved host profile and its OpenSSH overrides', () => {
  withAgentDir((agentDir) => {
    const host = saveRemoteHostProfile(
      {
        label: 'Cluster',
        hostAlias: 'lab-hpc',
        user: 'scientist',
        port: 22022,
        identityFile: '/tmp/lab-key'
      },
      agentDir
    )
    const connection: ProjectRemoteConnection = {
      id: 'connection-1',
      label: 'Slurm',
      hostProfileId: host.id,
      hpc: { scheduler: 'slurm' }
    }
    assert.deepEqual(resolveRemoteConnectionConfig(connection, agentDir), {
      host: 'lab-hpc',
      user: 'scientist',
      port: 22022,
      identityFile: '/tmp/lab-key'
    })
    const options = resolveProjectRemoteSubmitOptions(project(connection), agentDir)
    assert.deepEqual(options?.connection, {
      host: 'lab-hpc',
      user: 'scientist',
      port: 22022,
      identityFile: '/tmp/lab-key'
    })
    assert.equal(options?.remoteWorkspaceRoot, '/cluster/lab/.phi')
  })
})

test('remote targets inherit server-level Nextflow and Docker overrides', () => {
  withAgentDir((agentDir) => {
    const host = saveRemoteHostProfile({ label: 'GPU', hostAlias: 'gpu' }, agentDir)
    saveHostRemoteEnvironmentPaths(
      host.id,
      {
        nextflow: '/opt/nextflow/bin/nextflow',
        docker: '/opt/docker/bin/docker'
      },
      agentDir
    )
    const connection: ProjectRemoteConnection = {
      id: 'gpu',
      label: 'GPU',
      hostProfileId: host.id,
      hpc: { scheduler: 'local', runtime: 'docker' }
    }

    const submit = resolveProjectRemoteSubmitOptions(project(connection), agentDir)
    assert.equal(submit?.hpc?.nextflowBin, '/opt/nextflow/bin/nextflow')
    assert.equal(submit?.hpc?.containerRuntimeBin, '/opt/docker/bin/docker')

    const target = resolveProjectRemoteTarget(project(connection), undefined, agentDir)
    assert.ok('target' in target)
    assert.equal(target.target.hpc?.nextflowBin, '/opt/nextflow/bin/nextflow')
    assert.equal(target.target.hpc?.containerRuntimeBin, '/opt/docker/bin/docker')
  })
})

test('SSH project always resolves its bound host and canonical directory', () => {
  withAgentDir((agentDir) => {
    const host = saveRemoteHostProfile(
      { label: 'Cluster', hostAlias: 'cluster-a', user: 'scientist', port: 22022 },
      agentDir
    )
    const other = saveRemoteHostProfile({ label: 'Other', hostAlias: 'cluster-b' }, agentDir)
    const sshProject: Project = {
      ...project({ id: 'unused', label: 'Unused', hostProfileId: host.id }),
      location: {
        kind: 'ssh',
        hostProfileId: host.id,
        remoteRoot: '/home/me/project-link',
        canonicalRoot: '/data/project'
      },
      remoteConnections: [],
      defaultRemoteConnectionId: undefined,
      remoteWorkspaceRoot: undefined
    }
    const selected = resolveProjectRemoteTarget(sshProject, undefined, agentDir)
    assert.ok('target' in selected)
    assert.deepEqual(selected.target.connection, {
      host: 'cluster-a',
      user: 'scientist',
      port: 22022
    })
    assert.equal(selected.target.workspaceRoot, '/data/project')
    assert.equal(selected.target.hpc?.scheduler, 'local')
    assert.equal(selected.connectionId, host.id)
    const runtime: ProjectRemoteConnection = {
      id: 'runtime',
      label: 'Slurm runtime',
      hostProfileId: host.id,
      hpc: { scheduler: 'slurm', controller: 'sbatch', runtime: 'singularity' }
    }
    const configured = resolveProjectRemoteTarget(
      {
        ...sshProject,
        remoteConnections: [runtime],
        defaultRemoteConnectionId: runtime.id,
        remoteWorkspaceRoot: '/different/local-project-value'
      },
      undefined,
      agentDir
    )
    assert.ok('target' in configured)
    assert.equal(configured.target.workspaceRoot, '/data/project')
    assert.equal(configured.target.hpc?.scheduler, 'slurm')
    assert.equal(configured.target.hpc?.controller, 'sbatch')
    const wrongConnection: ProjectRemoteConnection = {
      id: 'other',
      label: 'Other',
      hostProfileId: other.id,
      hpc: { scheduler: 'slurm' }
    }
    const refused = resolveProjectRemoteTarget(
      { ...sshProject, remoteConnections: [wrongConnection], defaultRemoteConnectionId: 'other' },
      undefined,
      agentDir
    )
    assert.ok('reason' in refused)
    assert.match(refused.reason, /另一台服务器/)
  })
})

test('removed or old-format host bindings fail with a reconfiguration reason', () => {
  withAgentDir((agentDir) => {
    const connection: ProjectRemoteConnection = {
      id: 'connection-1',
      label: 'Old',
      hostProfileId: 'missing',
      hpc: { scheduler: 'slurm' }
    }
    assert.throws(() => resolveRemoteConnectionConfig(connection, agentDir), /重新配置/)
    const result = resolveProjectRemoteTarget(project(connection), undefined, agentDir)
    assert.ok('reason' in result)
    assert.match(result.reason, /重新配置/)
  })
})

test('remote target requires project, workspace, connection and HPC settings', () => {
  withAgentDir((agentDir) => {
    const host = saveRemoteHostProfile({ label: 'Server', hostAlias: 'server' }, agentDir)
    const connection: ProjectRemoteConnection = {
      id: 'connection-1',
      label: 'Direct',
      hostProfileId: host.id
    }
    assert.match(
      (resolveProjectRemoteTarget(undefined, undefined, agentDir) as { reason: string }).reason,
      /项目/
    )
    assert.match(
      (
        resolveProjectRemoteTarget(
          { ...project(connection), remoteWorkspaceRoot: undefined },
          undefined,
          agentDir
        ) as { reason: string }
      ).reason,
      /服务器工作目录/
    )
    assert.match(
      (resolveProjectRemoteTarget(project(connection), 'other', agentDir) as { reason: string })
        .reason,
      /找不到/
    )
    assert.match(
      (resolveProjectRemoteTarget(project(connection), undefined, agentDir) as { reason: string })
        .reason,
      /运行方式/
    )
  })
})

test('a project can select a non-default host binding without leaking credentials', () => {
  withAgentDir((agentDir) => {
    const first = saveRemoteHostProfile({ label: 'A', hostAlias: 'host-a' }, agentDir)
    const second = saveRemoteHostProfile({ label: 'B', hostAlias: 'host-b' }, agentDir)
    const connection: ProjectRemoteConnection = {
      id: 'default',
      label: 'Default',
      hostProfileId: first.id,
      hpc: { scheduler: 'slurm' }
    }
    const alternate: ProjectRemoteConnection = {
      id: 'alternate',
      label: 'Alternate',
      hostProfileId: second.id,
      hpc: { scheduler: 'local' }
    }
    const selected = resolveProjectRemoteTarget(
      { ...project(connection), remoteConnections: [connection, alternate] },
      'alternate',
      agentDir
    )
    assert.ok('target' in selected)
    assert.equal(selected.target.connection.host, 'host-b')
    assert.equal(selected.connectionId, 'alternate')
    assert.deepEqual(Object.keys(selected.target.connection), ['host'])
  })
})
