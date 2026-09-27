import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProject,
  assertProjectPathAvailable,
  getProjectByCwd,
  listProjects,
  readProjectGitStatus,
  updateProjectDefaults,
  updateProjectPermissionMode,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults,
  updateProjectWrapperDefault
} from '../src/main/agent/projects'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'

function withPhiDir<T>(callback: (paths: { phiDir: string; root: string }) => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'phi-projects-'))
  const phiDir = join(root, '.phi-home')
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return callback({ phiDir, root })
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(root, { recursive: true, force: true })
  }
}

test('createProject stores display path and realpath identity without creating project .phi', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)

    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })

    assert.equal(project.workingDirectory, projectDir)
    assert.equal(project.workingDirectoryRealPath, realpathSync(projectDir))
    assert.equal(project.pathAvailable, true)
    assert.equal(project.permissionMode, 'ask')
    assert.deepEqual(
      listProjects().map((item) => item.id),
      [project.id]
    )
    assert.equal(getProjectByCwd(projectDir)?.id, project.id)
  })
})

test('createProject rejects duplicate real paths even through symlinks', () => {
  withPhiDir(({ root }) => {
    const realDir = join(root, 'real')
    const linkedDir = join(root, 'linked')
    mkdirSync(realDir)
    symlinkSync(realDir, linkedDir, 'dir')

    createProject({ name: 'Real', workingDirectory: realDir, permissionMode: 'ask' })

    assert.throws(
      () => createProject({ name: 'Linked', workingDirectory: linkedDir, permissionMode: 'auto' }),
      /项目已存在/
    )
  })
})

test('createProject fails clearly when the selected path is unavailable', () => {
  withPhiDir(({ root }) => {
    assert.throws(
      () =>
        createProject({
          name: 'Missing',
          workingDirectory: join(root, 'missing'),
          permissionMode: 'ask'
        }),
      /项目路径不可用/
    )
  })
})

test('listProjects marks removed project paths unavailable and blocks new sessions', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'removed')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Removed',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })

    rmSync(projectDir, { recursive: true, force: true })
    const [listed] = listProjects()

    assert.equal(listed.id, project.id)
    assert.equal(listed.pathAvailable, false)
    assert.equal(listed.gitStatus, undefined)
    assert.throws(() => assertProjectPathAvailable(projectDir), /项目路径不可用/)
  })
})

test('project defaults and permission mode update independently', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })

    const withDefaults = updateProjectDefaults(project.id, {
      defaultModel: { providerId: 'openai', modelId: 'gpt-test' },
      defaultThinkingLevel: 'high'
    })
    assert.deepEqual(withDefaults.defaultModel, { providerId: 'openai', modelId: 'gpt-test' })
    assert.equal(withDefaults.defaultThinkingLevel, 'high')
    assert.equal(withDefaults.permissionMode, 'ask')

    const withAuto = updateProjectPermissionMode(project.id, 'auto')
    assert.equal(withAuto.permissionMode, 'auto')
    assert.deepEqual(withAuto.defaultModel, { providerId: 'openai', modelId: 'gpt-test' })

    const withFull = updateProjectPermissionMode(project.id, 'full')
    assert.equal(withFull.permissionMode, 'full')
    assert.deepEqual(withFull.defaultModel, { providerId: 'openai', modelId: 'gpt-test' })

    const cleared = updateProjectDefaults(project.id, {
      defaultModel: null,
      defaultThinkingLevel: null
    })
    assert.equal(cleared.defaultModel, undefined)
    assert.equal(cleared.defaultThinkingLevel, undefined)
  })
})

test('project wrapper defaults set, merge, and clear independently of other defaults', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })

    const withWrapperDefault = updateProjectWrapperDefault(project.id, 'phi/ngs/fastq-qc', {
      version: '1.0.0',
      params: { threads: 16 }
    })
    assert.deepEqual(withWrapperDefault.wrapperDefaults?.['phi/ngs/fastq-qc'], {
      version: '1.0.0',
      params: { threads: 16 }
    })

    const merged = updateProjectWrapperDefault(project.id, 'phi/ngs/fastq-qc', {
      resources: { cpus: 16, memory: '32 GB' }
    })
    assert.deepEqual(merged.wrapperDefaults?.['phi/ngs/fastq-qc'], {
      version: '1.0.0',
      params: { threads: 16 },
      resources: { cpus: 16, memory: '32 GB' }
    })

    const cleared = updateProjectWrapperDefault(project.id, 'phi/ngs/fastq-qc', null)
    assert.equal(cleared.wrapperDefaults?.['phi/ngs/fastq-qc'], undefined)
  })
})

test('project remote connections are added, replaced, and removed independently of the default pointer', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile({ label: 'Lab HPC', hostAlias: 'lab-hpc' })

    const withConnection = updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      hostProfileId: host.id
    })
    assert.deepEqual(withConnection.remoteConnections, [
      {
        id: 'conn1',
        label: 'Lab HPC',
        hostProfileId: host.id
      }
    ])

    // Replacing by the same id updates in place rather than appending a duplicate.
    const replaced = updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC (renamed)',
      hostProfileId: host.id
    })
    assert.equal(replaced.remoteConnections?.length, 1)
    assert.equal(replaced.remoteConnections?.[0].label, 'Lab HPC (renamed)')

    const withDefault = updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })
    assert.equal(withDefault.defaultRemoteConnectionId, 'conn1')
    assert.equal(withDefault.remoteWorkspaceRoot, '/data/lab/.phi')

    // Removing the connection that is currently the default also clears the default pointer.
    const removed = updateProjectRemoteConnection(project.id, 'conn1', null)
    assert.equal(removed.remoteConnections?.length, 0)
    assert.equal(removed.defaultRemoteConnectionId, undefined)
    // remoteWorkspaceRoot is independent state — untouched by removing a connection.
    assert.equal(removed.remoteWorkspaceRoot, '/data/lab/.phi')
  })
})

test('only local projects can save a valid local-root to server-root input mapping', () => {
  withPhiDir(({ root, phiDir }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster-a' })
    const patch = {
      id: 'conn1',
      label: 'Cluster',
      hostProfileId: host.id,
      inputPathMapping: {
        localRoot: `${projectDir}/data/..`,
        remoteRoot: '/cluster/project/data/..'
      }
    }
    const saved = updateProjectRemoteConnection(project.id, patch.id, patch)
    assert.deepEqual(saved.remoteConnections?.[0]?.inputPathMapping, {
      localRoot: projectDir,
      remoteRoot: '/cluster/project'
    })
    assert.throws(
      () =>
        updateProjectRemoteConnection(project.id, patch.id, {
          ...patch,
          inputPathMapping: { localRoot: 'relative', remoteRoot: '/cluster/project' }
        }),
      /本地映射根/
    )
    const sshRecord = {
      ...project,
      location: {
        kind: 'ssh',
        hostProfileId: host.id,
        remoteRoot: '/remote/work',
        canonicalRoot: '/remote/work'
      }
    }
    writeFileSync(join(phiDir, 'projects.json'), JSON.stringify([sshRecord]))
    assert.throws(
      () => updateProjectRemoteConnection(project.id, patch.id, patch),
      /远程项目不能配置/
    )
  })
})

test('updateProjectRemoteDefaults clears fields independently when passed null', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'demo')
    mkdirSync(projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const clearedConnection = updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: null
    })
    assert.equal(clearedConnection.defaultRemoteConnectionId, undefined)
    assert.equal(clearedConnection.remoteWorkspaceRoot, '/data/lab/.phi')

    const clearedRoot = updateProjectRemoteDefaults(project.id, { remoteWorkspaceRoot: null })
    assert.equal(clearedRoot.remoteWorkspaceRoot, undefined)
  })
})

test('readProjectGitStatus reports branch and dirty marker for git projects', () => {
  withPhiDir(({ root }) => {
    const projectDir = join(root, 'repo')
    mkdirSync(projectDir)
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' })

    assert.deepEqual(readProjectGitStatus(projectDir), { branch: 'main', dirty: false })

    writeFileSync(join(projectDir, 'note.txt'), 'draft', 'utf-8')

    assert.deepEqual(readProjectGitStatus(projectDir), { branch: 'main', dirty: true })
  })
})

test('listProjects includes lightweight git status without requiring git repositories', () => {
  withPhiDir(({ root }) => {
    const plainDir = join(root, 'plain')
    const gitDir = join(root, 'git')
    mkdirSync(plainDir)
    mkdirSync(gitDir)
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitDir, stdio: 'ignore' })

    const plain = createProject({
      name: 'Plain',
      workingDirectory: plainDir,
      permissionMode: 'ask'
    })
    const git = createProject({ name: 'Git', workingDirectory: gitDir, permissionMode: 'ask' })

    const projects = listProjects()

    assert.equal(projects.find((project) => project.id === plain.id)?.gitStatus, undefined)
    assert.deepEqual(projects.find((project) => project.id === git.id)?.gitStatus, {
      branch: 'main',
      dirty: false
    })
  })
})
