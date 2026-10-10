import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import {
  createProject,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults
} from '../src/main/agent/projects'
import {
  listRemoteHostsWithRuntimeRoots,
  saveRemoteEnvironmentSetting,
  saveRemoteMicromambaMirrorSetting,
  saveRemoteRuntimeRootSetting,
  updateProjectRemoteConnectionRuntimeAware
} from '../src/main/agent/remote-runtime-root-settings'
import { readHostRemoteEnvironmentPaths } from '../src/main/agent/remote-environment-store'
import { readHostRemoteMicromambaMirrorPrefix } from '../src/main/agent/remote-micromamba-mirror-store'
import { readHostRuntimeRoot } from '../src/main/agent/remote-runtime-root-store'
import {
  readCapabilityProfile,
  saveCapabilityProfile
} from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'

test('saving a host runtime root invalidates cached project profiles without touching host data', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-runtime-setting-'))
  try {
    const host = saveRemoteHostProfile({ label: 'GPU', hostAlias: 'gpu' }, agentDir)
    const key = { hostAlias: host.hostAlias, projectRoot: '/work/private-project' }
    saveCapabilityProfile(
      key,
      parseHostCapabilityProbe(
        '__PHI_CAPABILITY_PROBE_V1_BEGIN__\n' +
          'platform.os=Linux\nplatform.arch=x86_64\nprobe.complete=1\n' +
          '__PHI_CAPABILITY_PROBE_V1_END__\n'
      ),
      agentDir
    )

    const updated = saveRemoteRuntimeRootSetting(host.id, '/data/scientist/runtime/', agentDir)

    assert.equal(updated.runtimeRoot, '/data/scientist/runtime')
    assert.equal(
      listRemoteHostsWithRuntimeRoots(agentDir, '/missing/ssh-config')[0].runtimeRoot,
      updated.runtimeRoot
    )
    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
    assert.equal(updated.hostAlias, 'gpu')
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('saving a host download mirror validates and returns the per-host prefix', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-micromamba-mirror-setting-'))
  try {
    const host = saveRemoteHostProfile({ label: 'GPU', hostAlias: 'gpu' }, agentDir)
    const updated = saveRemoteMicromambaMirrorSetting(
      host.id,
      '  https://mirror.example/proxy/  ',
      agentDir,
      '/missing/ssh-config'
    )

    assert.equal(updated.downloadMirrorPrefix, 'https://mirror.example/proxy/')
    assert.equal(
      listRemoteHostsWithRuntimeRoots(agentDir, '/missing/ssh-config')[0].downloadMirrorPrefix,
      updated.downloadMirrorPrefix
    )
    assert.equal(
      readHostRemoteMicromambaMirrorPrefix(host.id, agentDir),
      'https://mirror.example/proxy/'
    )
    assert.throws(
      () => saveRemoteMicromambaMirrorSetting(host.id, 'http://mirror.example/', agentDir),
      /必须使用 https:\/\//
    )
    assert.throws(
      () => saveRemoteMicromambaMirrorSetting(host.id, 'https://mirror.example/path', agentDir),
      /必须以 \/ 结尾/
    )
    const cleared = saveRemoteMicromambaMirrorSetting(host.id, undefined, agentDir)
    assert.equal(cleared.downloadMirrorPrefix, undefined)
    assert.equal(readHostRemoteMicromambaMirrorPrefix(host.id, agentDir), undefined)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('saving a host environment keeps Phi defaults implicit and persists only path overrides', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-environment-setting-'))
  try {
    const host = saveRemoteHostProfile({ label: 'GPU', hostAlias: 'gpu' }, agentDir)
    const updated = saveRemoteEnvironmentSetting(
      host.id,
      {
        runtimeRoot: '  /data/phi/runtime/  ',
        toolPaths: {
          nextflow: ' /opt/nextflow/bin/nextflow ',
          jupyter: '',
          micromamba: '/home/scientist/bin/micromamba',
          docker: '/usr/local/bin/docker'
        }
      },
      agentDir,
      '/missing/ssh-config'
    )

    assert.equal(updated.runtimeRoot, '/data/phi/runtime')
    assert.deepEqual(updated.toolPaths, {
      nextflow: '/opt/nextflow/bin/nextflow',
      micromamba: '/home/scientist/bin/micromamba',
      docker: '/usr/local/bin/docker'
    })
    assert.deepEqual(readHostRemoteEnvironmentPaths(host.id, agentDir), updated.toolPaths)
    assert.deepEqual(
      listRemoteHostsWithRuntimeRoots(agentDir, '/missing/ssh-config')[0].toolPaths,
      updated.toolPaths
    )

    assert.throws(
      () =>
        saveRemoteEnvironmentSetting(
          host.id,
          { toolPaths: { nextflow: 'relative/nextflow' } },
          agentDir
        ),
      /绝对路径/
    )

    const cleared = saveRemoteEnvironmentSetting(
      host.id,
      { runtimeRoot: undefined, toolPaths: {} },
      agentDir
    )
    assert.equal(cleared.runtimeRoot, undefined)
    assert.equal(cleared.toolPaths, undefined)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('changing a project override invalidates only its profile and leaves the host override intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-project-runtime-setting-'))
  const agentDir = join(root, '.phi')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Project',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile({ label: 'GPU', hostAlias: 'gpu' }, agentDir)
    saveRemoteRuntimeRootSetting(host.id, '/data/host-runtime', agentDir)
    const connection = {
      id: 'gpu-runtime',
      label: 'GPU',
      hostProfileId: host.id,
      runtimeRoot: '/data/project-runtime'
    }
    updateProjectRemoteConnection(project.id, connection.id, connection)
    updateProjectRemoteDefaults(project.id, { remoteWorkspaceRoot: '/work/project' })
    const key = { hostAlias: host.hostAlias, projectRoot: '/work/project' }
    saveCapabilityProfile(
      key,
      parseHostCapabilityProbe(
        '__PHI_CAPABILITY_PROBE_V1_BEGIN__\n' +
          'platform.os=Linux\nplatform.arch=x86_64\nprobe.complete=1\n' +
          '__PHI_CAPABILITY_PROBE_V1_END__\n'
      ),
      agentDir
    )

    updateProjectRemoteConnectionRuntimeAware(
      project.id,
      connection.id,
      { ...connection, runtimeRoot: '/data/project-runtime-next' },
      agentDir
    )

    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
    assert.equal(readHostRuntimeRoot(host.id, agentDir), '/data/host-runtime')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
