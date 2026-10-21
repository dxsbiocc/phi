import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import type { AppLogEntry } from '../src/main/agent/app-logger'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import type { SkillSummary } from '../src/shared/skillTypes'
import { createProjectRuntimeRootContext } from '../src/main/agent/remote-runtime/project-runtime-root-context'
import { createRemoteProjectContext } from '../src/main/agent/remote-runtime/remote-project-context'
import {
  createRemoteProjectRequests,
  remoteRequestProjectId
} from '../src/main/agent/remote-runtime/remote-project-requests'
import { createRemoteProjectSkills } from '../src/main/agent/remote-runtime/remote-project-skills'

type SshProject = Project & {
  location: Extract<Project['location'], { kind: 'ssh' }>
}

const sshProject: SshProject = {
  id: 'project-remote',
  name: 'Remote project',
  location: {
    kind: 'ssh',
    hostProfileId: 'host-1',
    remoteRoot: '/remote/project',
    canonicalRoot: '/canonical/project'
  },
  workingDirectory: '/working/project',
  workingDirectoryRealPath: '/working/project',
  permissionMode: 'ask',
  pathAvailable: true,
  createdAt: '2026-10-21T00:00:00.000Z'
}

const localProject: Project = {
  ...sshProject,
  id: 'project-local',
  name: 'Local project',
  location: { kind: 'local', path: '/local/project', realPath: '/local/project' },
  workingDirectory: '/local/project',
  workingDirectoryRealPath: '/local/project'
}

function manifest(projectId = sshProject.id): PhiSessionManifest {
  return {
    sessionId: 'session-1',
    projectId,
    cwd: '/manifest/project'
  } as PhiSessionManifest
}

function skill(name: string, source: string): SkillSummary {
  return {
    id: `${source}:${name}`,
    name,
    description: `${name} description`,
    filePath: `/${source}/${name}/SKILL.md`,
    source,
    scope: 'user',
    sourceCategory: 'user',
    sourceCategoryLabel: 'User',
    enabled: true,
    globalEnabled: true,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: false
  }
}

test('projectRemoteRuntimeRoot uses the SSH host override and skips it for local projects', () => {
  const calls: string[] = []
  const roots = createProjectRuntimeRootContext({
    agentDir: '/agent',
    services: {
      readHostRuntimeRoot: (hostProfileId, agentDir) => {
        calls.push(`read:${hostProfileId}:${agentDir}`)
        return '/host/runtime'
      },
      resolveProjectRuntimeRoot: (project, hostOverride) => {
        calls.push(`resolve:${project.id}:${hostOverride ?? 'none'}`)
        return {
          source: hostOverride ? 'host' : 'default',
          configured: hostOverride ?? '~/.phi/runtime'
        }
      }
    }
  })

  assert.deepEqual(roots.projectRemoteRuntimeRoot(sshProject), {
    source: 'host',
    configured: '/host/runtime'
  })
  assert.deepEqual(roots.projectRemoteRuntimeRoot(localProject), {
    source: 'default',
    configured: '~/.phi/runtime'
  })
  assert.deepEqual(calls, [
    'read:host-1:/agent',
    'resolve:project-remote:/host/runtime',
    'resolve:project-local:none'
  ])
})

test('currentRemoteAnalysisProject accepts every SSH project root and rejects local context', () => {
  const state = { sessionKey: 'key-1', sessionPath: '/session.jsonl', cwd: '/session/cwd' }
  let selectedProject: Project | undefined = sshProject
  const contexts = createRemoteProjectContext({
    sessionState: state,
    sessionResolution: { findPhiManifestForSession: () => manifest() },
    agentDir: '/agent',
    services: {
      getProject: () => selectedProject,
      isRemoteProjectAnchorPath: () => false
    }
  })

  for (const cwd of [
    '/manifest/project',
    sshProject.workingDirectory,
    sshProject.location.remoteRoot,
    sshProject.location.canonicalRoot
  ]) {
    assert.deepEqual(contexts.currentRemoteAnalysisProject(cwd), {
      project: sshProject,
      sessionId: 'session-1'
    })
  }
  assert.equal(contexts.currentRemoteAnalysisProject('/unrelated'), null)

  selectedProject = localProject
  assert.equal(contexts.currentRemoteAnalysisProject(localProject.workingDirectory), null)
})

test('remote resource and skill contexts read the live session state', () => {
  const state = { sessionKey: 'key-1', sessionPath: undefined as string | undefined, cwd: '/local' }
  const contexts = createRemoteProjectContext({
    sessionState: state,
    sessionResolution: { findPhiManifestForSession: () => manifest() },
    agentDir: '/agent',
    services: {
      getProject: () => sshProject,
      isRemoteProjectAnchorPath: (path, agentDir) =>
        agentDir === '/agent' && path.startsWith('/agent/remote-project-anchors/')
    }
  })

  assert.equal(contexts.isRemoteResourceScope('/agent/remote-project-anchors/project-remote'), true)
  assert.equal(contexts.isRemoteResourceScope('/local'), false)

  state.cwd = sshProject.location.canonicalRoot
  assert.deepEqual(contexts.remoteSkillProjectContext('/requested/non-project/path'), {
    sessionId: 'session-1',
    projectId: sshProject.id,
    cwd: '/requested/non-project/path',
    agentDir: '/agent'
  })

  state.cwd = '/agent/remote-project-anchors/project-remote'
  assert.equal(contexts.isRemoteResourceScope('/local'), true)
})

test('remoteSkillProjectContext rejects missing projects', () => {
  const contexts = createRemoteProjectContext({
    sessionState: { sessionKey: 'key-1', sessionPath: undefined, cwd: '/missing' },
    sessionResolution: { findPhiManifestForSession: () => manifest('missing-project') },
    agentDir: '/agent',
    services: {
      getProject: () => undefined,
      isRemoteProjectAnchorPath: () => false
    }
  })

  assert.throws(
    () => contexts.remoteSkillProjectContext(),
    /远程项目 Skill 请求缺少有效的当前项目会话/
  )
})

test('remoteRequestProjectId accepts only string project ids on objects', () => {
  assert.equal(remoteRequestProjectId({ projectId: 'project-1' }), 'project-1')
  assert.equal(remoteRequestProjectId({ projectId: 1 }), '')
  assert.equal(remoteRequestProjectId(null), '')
  assert.equal(remoteRequestProjectId('project-1'), '')
})

test('scheduleRemoteProjectCheck logs a rejected background check', async () => {
  const calls: string[] = []
  let resolveLogged!: (entry: AppLogEntry) => void
  const logged = new Promise<AppLogEntry>((resolve) => {
    resolveLogged = resolve
  })
  const requests = createRemoteProjectRequests({
    remoteConnectionTracker: {
      check: async (sessionId, projectId) => {
        calls.push(`${sessionId}:${projectId}`)
        throw new Error('offline')
      }
    },
    writeAppLog: (entry) => resolveLogged(entry)
  })

  assert.equal(requests.scheduleRemoteProjectCheck('session-1', 'project-1'), undefined)
  assert.deepEqual(await logged, {
    level: 'warn',
    event: 'remote_project_connection_check_failed',
    sessionId: 'session-1',
    metadata: { projectId: 'project-1', reason: 'offline' }
  })
  assert.deepEqual(calls, ['session-1:project-1'])
})

test('listRemoteProjectSkills replaces shadowed globals with the remote catalog', async () => {
  const duplicateGlobal = skill('shared', 'global')
  const globalOnly = skill('global-only', 'global')
  const remoteShared = { ...skill('shared', 'remote'), scope: 'project' as const }
  const contexts: unknown[] = []
  const remoteSkills = createRemoteProjectSkills({
    remoteSkillProjectContext: (cwd) => ({
      sessionId: 'session-1',
      projectId: 'project-1',
      cwd: cwd ?? '/current',
      agentDir: '/agent'
    }),
    services: {
      listGlobalSkills: async () => [duplicateGlobal, globalOnly],
      loadRemoteProjectSkillCatalog: async (context) => {
        contexts.push(context)
        return {
          entries: [],
          diagnostics: [],
          sources: [{ name: 'shared' }],
          summaries: [remoteShared]
        } as never
      }
    }
  })

  assert.deepEqual(await remoteSkills.listRemoteProjectSkills('/requested'), [
    globalOnly,
    remoteShared
  ])
  assert.deepEqual(contexts, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      cwd: '/requested',
      agentDir: '/agent'
    }
  ])
})
