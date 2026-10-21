import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ModelSelection,
  type PermissionMode,
  type Project,
  type ThinkingLevel
} from '../src/main/agent/projects'
import { phiOnlySessionPath } from '../src/main/agent/session/sessions'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import type { SessionPreferenceTable } from '../src/main/app-state/session-preferences'
import { createSessionResolution } from '../src/main/session-runtime/session-resolution'

interface ResolutionHarness {
  resolution: ReturnType<typeof createSessionResolution>
  activeRuns: Map<string, { phiSessionId: string }>
  phiSessionIds: Map<string, string>
  modelSelections: SessionPreferenceTable<ModelSelection | null>
  thinkingLevels: SessionPreferenceTable<ThinkingLevel>
  permissionModes: SessionPreferenceTable<PermissionMode>
  setSelectedModel: (selection: ModelSelection | null) => void
  setDefaultThinkingLevel: (level: ThinkingLevel) => void
}

const manifests = new Map<string, PhiSessionManifest>()
const projects = new Map<string, Project>()
let nextManifestId = 0
let nextProjectId = 0

function preferenceTable<T>(): SessionPreferenceTable<T> {
  const values = new Map<string, T>()
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
    has: (key) => values.has(key),
    delete: (key) => values.delete(key)
  }
}

function createHarness(options?: {
  canonicalize?: (key: string) => string
  onActiveRun?: (key: string) => void
  onPhiSessionId?: (key: string) => void
  permissionModes?: SessionPreferenceTable<PermissionMode>
}): ResolutionHarness {
  const activeRuns = new Map<string, { phiSessionId: string }>()
  const phiSessionIds = new Map<string, string>()
  const modelSelections = preferenceTable<ModelSelection | null>()
  const thinkingLevels = preferenceTable<ThinkingLevel>()
  const permissionModes = options?.permissionModes ?? preferenceTable<PermissionMode>()
  let selectedModel: ModelSelection | null = null
  let defaultThinkingLevel: ThinkingLevel = 'high'
  const canonicalize = options?.canonicalize ?? ((key: string) => key)

  return {
    resolution: createSessionResolution({
      promptRuns: {
        activeRun: (key) => {
          options?.onActiveRun?.(key)
          return activeRuns.get(canonicalize(key))
        }
      },
      sessionKeys: {
        canonicalize,
        phiSessionIdFor: (key) => {
          options?.onPhiSessionId?.(key)
          return phiSessionIds.get(canonicalize(key))
        }
      },
      modelSelections,
      thinkingLevels,
      permissionModes,
      getSelectedModel: () => selectedModel,
      getDefaultThinkingLevel: () => defaultThinkingLevel,
      stores: {
        listPhiSessions: () => [...manifests.values()],
        findPhiSessionById: (sessionId) => manifests.get(sessionId) ?? null,
        findPhiSessionByRuntimePath: (runtimeSessionPath, cwd) =>
          [...manifests.values()].find(
            (manifest) =>
              manifest.runtimeSessionPath === runtimeSessionPath &&
              (cwd === undefined || manifest.cwd === cwd)
          ) ?? null,
        getProject: (id) => projects.get(id),
        getProjectByCwd: (cwd) =>
          [...projects.values()].find((project) => project.workingDirectory === cwd)
      }
    }),
    activeRuns,
    phiSessionIds,
    modelSelections,
    thinkingLevels,
    permissionModes,
    setSelectedModel: (selection) => {
      selectedModel = selection
    },
    setDefaultThinkingLevel: (level) => {
      defaultThinkingLevel = level
    }
  }
}

function createManifest(
  input: Partial<PhiSessionManifest> & Pick<PhiSessionManifest, 'cwd'>
): PhiSessionManifest {
  const timestamp = '2026-10-21T00:00:00.000Z'
  const manifest: PhiSessionManifest = {
    schemaVersion: 1,
    sessionId: `manifest-${++nextManifestId}`,
    kind: input.projectId ? 'project' : 'ordinary',
    projectId: input.projectId ?? null,
    cwdRealPath: input.cwd,
    permissionMode: 'auto',
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    ...input
  }
  manifests.set(manifest.sessionId, manifest)
  return manifest
}

function createTestProject(name: string, permissionMode: PermissionMode = 'ask'): Project {
  const id = `project-${++nextProjectId}`
  const workingDirectory = `/projects/${name}-${nextProjectId}`
  const project: Project = {
    id,
    name,
    location: { kind: 'local', path: workingDirectory, realPath: workingDirectory },
    workingDirectory,
    workingDirectoryRealPath: workingDirectory,
    permissionMode,
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  }
  projects.set(id, project)
  return project
}

function updateTestProjectDefaults(
  project: Project,
  defaults: Partial<Pick<Project, 'defaultModel' | 'defaultThinkingLevel'>>
): void {
  Object.assign(project, defaults)
}

test('findPhiManifestForSession prefers the active run Phi id over the key Phi id', () => {
  const lookups: string[] = []
  const harness = createHarness({
    onActiveRun: () => lookups.push('active-run'),
    onPhiSessionId: () => lookups.push('session-key')
  })
  const activeManifest = createManifest({ cwd: '/active-workspace' })
  const keyManifest = createManifest({ cwd: '/key-workspace' })
  harness.activeRuns.set('session', { phiSessionId: activeManifest.sessionId })
  harness.phiSessionIds.set('session', keyManifest.sessionId)

  assert.equal(
    harness.resolution.findPhiManifestForSession('session', undefined, '/workspace')?.sessionId,
    activeManifest.sessionId
  )
  assert.deepEqual(lookups, ['active-run'])
})

test('findPhiManifestForSession uses the key Phi id when there is no active run', () => {
  const harness = createHarness()
  const manifest = createManifest({ cwd: '/key-workspace' })
  harness.phiSessionIds.set('session', manifest.sessionId)

  assert.equal(
    harness.resolution.findPhiManifestForSession('session', undefined, '/workspace')?.sessionId,
    manifest.sessionId
  )
})

test('findPhiManifestForSession resolves Phi-only and runtime paths and returns null without a path', () => {
  const harness = createHarness()
  const phiOnlyManifest = createManifest({ cwd: '/phi-only-workspace' })
  createManifest({
    cwd: phiOnlyManifest.cwd,
    runtimeSessionPath: phiOnlySessionPath(phiOnlyManifest.sessionId)
  })
  const runtimeManifest = createManifest({
    cwd: '/runtime-workspace',
    runtimeSessionPath: '/runtime/session.jsonl'
  })

  assert.equal(
    harness.resolution.findPhiManifestForSession(
      'phi-only',
      phiOnlySessionPath(phiOnlyManifest.sessionId),
      phiOnlyManifest.cwd
    )?.sessionId,
    phiOnlyManifest.sessionId
  )
  assert.equal(
    harness.resolution.findPhiManifestForSession(
      'runtime',
      runtimeManifest.runtimeSessionPath,
      runtimeManifest.cwd
    )?.sessionId,
    runtimeManifest.sessionId
  )
  assert.equal(
    harness.resolution.findPhiManifestForSession('pathless', undefined, '/workspace'),
    null
  )
})

test('findPhiManifestForSession uses a runtime path when the remembered Phi id has no record', () => {
  const harness = createHarness()
  const runtimeManifest = createManifest({
    cwd: '/runtime-workspace',
    runtimeSessionPath: '/runtime/remembered.jsonl'
  })
  harness.phiSessionIds.set('session', 'missing-session')

  assert.equal(
    harness.resolution.findPhiManifestForSession(
      'session',
      runtimeManifest.runtimeSessionPath,
      runtimeManifest.cwd
    )?.sessionId,
    runtimeManifest.sessionId
  )
  harness.phiSessionIds.set('dangling', 'missing-session')
  assert.equal(
    harness.resolution.findPhiManifestForSession('dangling', undefined, '/workspace'),
    null
  )
})

test('projectForSession prefers a manifest project and otherwise resolves by cwd', () => {
  const manifestProject = createTestProject('manifest')
  const cwdProject = createTestProject('cwd')
  const manifest = createManifest({
    cwd: cwdProject.workingDirectory,
    cwdRealPath: cwdProject.workingDirectoryRealPath,
    projectId: manifestProject.id
  })
  const harness = createHarness()
  harness.phiSessionIds.set('manifest-session', manifest.sessionId)

  assert.equal(
    harness.resolution.projectForSession('manifest-session', {
      path: undefined,
      cwd: cwdProject.workingDirectory
    })?.id,
    manifestProject.id
  )
  assert.equal(
    harness.resolution.projectForSession('cwd-session', {
      path: undefined,
      cwd: cwdProject.workingDirectory
    })?.id,
    cwdProject.id
  )
})

test('resolveSessionModelSelection preserves table, manifest, project, and live global order', () => {
  const harness = createHarness({ canonicalize: (key) => (key === 'alias' ? 'canonical' : key) })
  const tableSelection = { providerId: 'table', modelId: 'table-model' }
  const manifestSelection = { providerId: 'manifest', modelId: 'manifest-model' }
  const projectSelection = { providerId: 'project', modelId: 'project-model' }
  const firstGlobalSelection = { providerId: 'global', modelId: 'first-global' }
  const secondGlobalSelection = { providerId: 'global', modelId: 'second-global' }
  const project = createTestProject('model')
  updateTestProjectDefaults(project, { defaultModel: projectSelection })
  const manifest = createManifest({
    cwd: project.workingDirectory,
    projectId: project.id,
    model: manifestSelection
  })
  harness.modelSelections.set('canonical', tableSelection)
  harness.phiSessionIds.set('manifest', manifest.sessionId)
  harness.setSelectedModel(firstGlobalSelection)

  assert.deepEqual(
    harness.resolution.resolveSessionModelSelection('alias', {
      path: undefined,
      cwd: '/table',
      permissionMode: 'auto'
    }),
    tableSelection
  )
  assert.deepEqual(
    harness.resolution.resolveSessionModelSelection('manifest', {
      path: undefined,
      cwd: project.workingDirectory,
      permissionMode: 'auto'
    }),
    manifestSelection
  )
  assert.deepEqual(
    harness.resolution.resolveSessionModelSelection('project', {
      path: undefined,
      cwd: project.workingDirectory,
      permissionMode: 'auto'
    }),
    projectSelection
  )
  assert.deepEqual(
    harness.resolution.resolveSessionModelSelection('global', {
      path: undefined,
      cwd: '/global',
      permissionMode: 'auto'
    }),
    firstGlobalSelection
  )

  harness.setSelectedModel(secondGlobalSelection)
  assert.deepEqual(
    harness.resolution.resolveSessionModelSelection('global', {
      path: undefined,
      cwd: '/global',
      permissionMode: 'auto'
    }),
    secondGlobalSelection
  )
})

test('resolveSessionThinkingLevel preserves table, manifest, project, and live default order', () => {
  const harness = createHarness({ canonicalize: (key) => (key === 'alias' ? 'canonical' : key) })
  const project = createTestProject('thinking')
  updateTestProjectDefaults(project, { defaultThinkingLevel: 'medium' })
  const manifest = createManifest({
    cwd: project.workingDirectory,
    projectId: project.id,
    thinkingLevel: 'low'
  })
  harness.thinkingLevels.set('canonical', 'xhigh')
  harness.phiSessionIds.set('manifest', manifest.sessionId)
  harness.setDefaultThinkingLevel('high')

  assert.equal(
    harness.resolution.resolveSessionThinkingLevel('alias', {
      path: undefined,
      cwd: '/table',
      permissionMode: 'auto'
    }),
    'xhigh'
  )
  assert.equal(
    harness.resolution.resolveSessionThinkingLevel('manifest', {
      path: undefined,
      cwd: project.workingDirectory,
      permissionMode: 'auto'
    }),
    'low'
  )
  assert.equal(
    harness.resolution.resolveSessionThinkingLevel('project', {
      path: undefined,
      cwd: project.workingDirectory,
      permissionMode: 'auto'
    }),
    'medium'
  )
  assert.equal(
    harness.resolution.resolveSessionThinkingLevel('global', {
      path: undefined,
      cwd: '/global',
      permissionMode: 'auto'
    }),
    'high'
  )

  harness.setDefaultThinkingLevel('max')
  assert.equal(
    harness.resolution.resolveSessionThinkingLevel('global', {
      path: undefined,
      cwd: '/global',
      permissionMode: 'auto'
    }),
    'max'
  )
})

test('resolveSessionPermissionMode writes back manifest mode before returning it', () => {
  const writes: Array<{ key: string; mode: PermissionMode }> = []
  const values = new Map<string, PermissionMode>()
  const permissionModes: SessionPreferenceTable<PermissionMode> = {
    get: (key) => values.get(key),
    set: (key, mode) => {
      writes.push({ key, mode })
      values.set(key, mode)
    },
    has: (key) => values.has(key),
    delete: (key) => values.delete(key)
  }
  const harness = createHarness({
    canonicalize: (key) => (key === 'alias' ? 'canonical' : key),
    permissionModes
  })
  const manifest = createManifest({ cwd: '/permission-manifest', permissionMode: 'full' })
  harness.phiSessionIds.set('canonical', manifest.sessionId)

  assert.equal(
    harness.resolution.resolveSessionPermissionMode('alias', {
      path: undefined,
      cwd: manifest.cwd
    }),
    'full'
  )
  assert.deepEqual(writes, [{ key: 'canonical', mode: 'full' }])
  assert.equal(values.get('canonical'), 'full')
})

test('resolveSessionPermissionMode preserves table, project, and auto fallback without a manifest', () => {
  const harness = createHarness({ canonicalize: (key) => (key === 'alias' ? 'canonical' : key) })
  const project = createTestProject('permission', 'ask')
  harness.permissionModes.set('canonical', 'full')

  assert.equal(
    harness.resolution.resolveSessionPermissionMode('alias', {
      path: undefined,
      cwd: '/table'
    }),
    'full'
  )
  assert.equal(
    harness.resolution.resolveSessionPermissionMode('project', {
      path: undefined,
      cwd: project.workingDirectory
    }),
    'ask'
  )
  assert.equal(
    harness.resolution.resolveSessionPermissionMode('global', {
      path: undefined,
      cwd: '/global'
    }),
    'auto'
  )
})
