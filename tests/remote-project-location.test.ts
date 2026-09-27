import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertProjectPathAvailable,
  createProject,
  createRemoteProject,
  getProject,
  getProjectByCwd,
  listProjects,
  renameProject,
  setRemoteProjectConnectionState,
  subscribeRemoteProjectConnection,
  updateProjectPermissionMode
} from '../src/main/agent/projects'
import { deleteRemoteHostProfile, saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { projectLocationSummary } from '../src/renderer/src/lib/projectTypes'

async function withPhiDir<T>(run: (root: string, agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-project-'))
  const agentDir = join(root, 'phi-home')
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await run(root, agentDir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}

function fakeSsh(canonicalRoot: string): {
  connectImpl: (config: { host: string }) => Promise<RemoteSshSession>
  commands: string[]
  hosts: string[]
  closed: () => number
} {
  const commands: string[] = []
  const hosts: string[] = []
  let closeCount = 0
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected SSH operation')
  }
  return {
    connectImpl: async ({ host }) => {
      hosts.push(host)
      return {
        exec: async (command) => {
          commands.push(command)
          return { stdout: `${canonicalRoot}\n`, stderr: '', code: 0, signal: null }
        },
        readTextFile: unused,
        writeTextFile: unused,
        mkdirp: unused,
        exists: unused,
        uploadFile: unused,
        close: async () => {
          closeCount += 1
        }
      }
    },
    commands,
    hosts,
    closed: () => closeCount
  }
}

test('SSH project identity is host profile plus server-canonical path, never local realpath', async () => {
  await withPhiDir(async () => {
    const hostA = saveRemoteHostProfile({ label: 'A', hostAlias: 'host-a' })
    const hostB = saveRemoteHostProfile({ label: 'B', hostAlias: 'host-b' })
    const root = "/server/project with 'quote'"
    const ssh = fakeSsh('/canonical/project')
    const first = await createRemoteProject(
      {
        name: 'Remote A',
        hostProfileId: hostA.id,
        remoteRoot: root,
        permissionMode: 'ask'
      },
      { connectImpl: ssh.connectImpl }
    )
    const second = await createRemoteProject(
      {
        name: 'Remote B',
        hostProfileId: hostB.id,
        remoteRoot: root,
        permissionMode: 'auto'
      },
      { connectImpl: ssh.connectImpl }
    )
    assert.notEqual(first.id, second.id)
    assert.deepEqual(first.location, {
      kind: 'ssh',
      hostProfileId: hostA.id,
      remoteRoot: root,
      canonicalRoot: '/canonical/project'
    })
    assert.deepEqual(ssh.hosts, ['host-a', 'host-b'])
    assert.match(ssh.commands[0], /^cd '\/server\/project with /)
    assert.equal(ssh.closed(), 2)
    assert.equal(getProject(first.id)?.location.kind, 'ssh')
    assert.equal(getProjectByCwd(root), undefined)
    assert.throws(() => assertProjectPathAvailable(root), /远程项目不能作为本地目录/)
    assert.equal(listProjects().filter((project) => project.location.kind === 'ssh').length, 2)
    await assert.rejects(
      () =>
        createRemoteProject(
          {
            name: 'Duplicate',
            hostProfileId: hostA.id,
            remoteRoot: '/another/symlink',
            permissionMode: 'ask'
          },
          { connectImpl: ssh.connectImpl }
        ),
      /已存在/
    )
  })
})

test('local and SSH projects can display the same path without sharing identity', async () => {
  await withPhiDir(async (root) => {
    const localPath = join(root, 'workspace')
    mkdirSync(localPath)
    const local = createProject({
      name: 'Local',
      workingDirectory: localPath,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster' })
    const ssh = fakeSsh(localPath)
    const remote = await createRemoteProject(
      {
        name: 'Remote',
        hostProfileId: host.id,
        remoteRoot: localPath,
        permissionMode: 'ask'
      },
      { connectImpl: ssh.connectImpl }
    )
    assert.notEqual(local.id, remote.id)
    assert.equal(local.location.kind, 'local')
    assert.equal(getProjectByCwd(localPath)?.id, local.id)
    assert.equal(listProjects().length, 2)
  })
})

test('remote reachability is distinct from a missing local folder and renaming preserves project ID', async () => {
  await withPhiDir(async () => {
    const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster' })
    const ssh = fakeSsh('/canonical/work')
    const project = await createRemoteProject(
      {
        name: 'Before',
        hostProfileId: host.id,
        remoteRoot: '/remote/work',
        permissionMode: 'ask'
      },
      { connectImpl: ssh.connectImpl }
    )
    setRemoteProjectConnectionState(project.id, { phase: 'offline' })
    assert.equal(updateProjectPermissionMode(project.id, 'auto').remoteConnection?.phase, 'offline')
    const [listed] = listProjects()
    assert.equal(listed.pathAvailable, true)
    assert.equal(listed.remoteReachability, 'offline')
    assert.equal(listed.gitStatus, undefined)
    assert.match(projectLocationSummary(listed), /cluster · \/remote\/work · 服务器离线/)
    const renamed = renameProject(project.id, 'After')
    assert.equal(renamed.id, project.id)
    assert.equal(getProject(project.id)?.name, 'After')
    deleteRemoteHostProfile(host.id)
    const [missingProfile] = listProjects()
    assert.equal(missingProfile.pathAvailable, true)
    assert.equal(missingProfile.remoteReachability, 'configuration_failed')
    assert.match(projectLocationSummary(missingProfile), /服务器档案不可用/)
  })
})

test('remote status changes notify project observers and stay separate from local projects', async () => {
  await withPhiDir(async (root) => {
    const localPath = join(root, 'workspace')
    mkdirSync(localPath)
    const local = createProject({
      name: 'Local',
      workingDirectory: localPath,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster' })
    const changes: Array<{ projectId: string; phase: string }> = []
    const unsubscribe = subscribeRemoteProjectConnection((projectId, state) => {
      changes.push({ projectId, phase: state.phase })
    })
    try {
      const remote = await createRemoteProject(
        {
          name: 'Remote',
          hostProfileId: host.id,
          remoteRoot: '/remote/work',
          permissionMode: 'ask'
        },
        { connectImpl: fakeSsh('/canonical/work').connectImpl }
      )
      setRemoteProjectConnectionState(remote.id, { phase: 'connecting' })
      setRemoteProjectConnectionState(remote.id, {
        phase: 'identity_failed',
        message: '主机身份已变化'
      })
      assert.deepEqual(changes, [
        { projectId: remote.id, phase: 'reachable' },
        { projectId: remote.id, phase: 'connecting' },
        { projectId: remote.id, phase: 'identity_failed' }
      ])
      assert.equal(
        listProjects().find((project) => project.id === remote.id)?.remoteConnection?.message,
        '主机身份已变化'
      )
      assert.equal(getProject(local.id)?.remoteConnection, undefined)
      assert.throws(
        () => setRemoteProjectConnectionState(local.id, { phase: 'offline' }),
        /远程项目不存在/
      )
      unsubscribe()
      setRemoteProjectConnectionState(remote.id, { phase: 'reachable' })
      assert.equal(changes.length, 3)
    } finally {
      unsubscribe()
    }
  })
})

test('old local project records gain a local location without a broad migration', async () => {
  await withPhiDir(async (root, agentDir) => {
    const localPath = join(root, 'legacy')
    mkdirSync(localPath)
    mkdirSync(agentDir)
    writeFileSync(
      join(agentDir, 'projects.json'),
      JSON.stringify([
        {
          id: 'legacy-id',
          name: 'Legacy',
          workingDirectory: localPath,
          workingDirectoryRealPath: localPath,
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    const [legacy] = listProjects()
    assert.deepEqual(legacy.location, {
      kind: 'local',
      path: localPath,
      realPath: realpathSync(localPath)
    })
    assert.equal(getProjectByCwd(localPath)?.id, 'legacy-id')
  })
})

test('invalid or inaccessible SSH paths never create a project record', async () => {
  await withPhiDir(async () => {
    const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster' })
    const ssh = fakeSsh('not-absolute')
    await assert.rejects(
      () =>
        createRemoteProject(
          {
            name: 'Bad',
            hostProfileId: host.id,
            remoteRoot: '/server/path',
            permissionMode: 'ask'
          },
          { connectImpl: ssh.connectImpl }
        ),
      /无法在服务器上确认/
    )
    await assert.rejects(
      () =>
        createRemoteProject(
          {
            name: 'Relative',
            hostProfileId: host.id,
            remoteRoot: '../relative',
            permissionMode: 'ask'
          },
          { connectImpl: ssh.connectImpl }
        ),
      /绝对路径/
    )
    assert.deepEqual(listProjects(), [])
  })
})
