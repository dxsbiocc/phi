import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import {
  createPromptRunAdmission,
  type PromptRunAdmissionDeps,
  type SubmitPromptInput
} from '../src/main/session-runtime/prompt-run-admission'

type Result = { id: string }

const project = {
  id: 'project-1',
  name: 'Project',
  location: { kind: 'local', path: '/work', realPath: '/work' },
  workingDirectory: '/work',
  workingDirectoryRealPath: '/work',
  permissionMode: 'ask',
  pathAvailable: true,
  createdAt: '2026-10-21T00:00:00.000Z'
} satisfies Project

function createDeps(
  overrides: {
    canonicalKey?: string
    project?: Project | undefined
    lifecycle?: SessionLifecycle<Result>
    hasActiveRun?: boolean
    recovering?: boolean
    compacting?: boolean
    ensurePhiSessionId?: PromptRunAdmissionDeps<Result>['linking']['ensurePhiSessionId']
    remoteAnchor?: boolean
  } = {}
): {
  deps: PromptRunAdmissionDeps<Result>
  calls: string[]
  lifecycle: SessionLifecycle<Result>
} {
  const calls: string[] = []
  const lifecycle = overrides.lifecycle ?? new SessionLifecycle<Result>()
  const deps: PromptRunAdmissionDeps<Result> = {
    keys: {
      canonicalize: (key) => overrides.canonicalKey ?? key
    },
    lifecycles: { forKey: () => lifecycle },
    resolution: {
      projectForSession: () => overrides.project,
      resolveSessionModelSelection: () => null
    },
    linking: {
      ensurePhiSessionId:
        overrides.ensurePhiSessionId ??
        ((_key, _snapshot, title) => {
          calls.push(`ensure:${title ?? ''}`)
          return 'phi-1'
        })
    },
    runs: {
      hasActiveRun: () => overrides.hasActiveRun ?? false,
      runtimeRecoveryOperations: { has: () => overrides.recovering ?? false },
      manualCompactionIds: { has: () => overrides.compacting ?? false }
    },
    paths: {
      phiOnlySessionPath: (id) => `/phi/${id}`,
      isRemoteAnchorPath: () => overrides.remoteAnchor ?? false
    },
    createRunId: () => 'run-1'
  }
  return { deps, calls, lifecycle }
}

function input(overrides: Partial<SubmitPromptInput> = {}): SubmitPromptInput {
  return {
    sessionKey: 'session-key',
    snapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
    text: 'hello',
    promptTarget: null,
    ...overrides
  }
}

test('resolvePromptRunTarget canonicalizes, snapshots the lifecycle, and reads the project', () => {
  const { deps, lifecycle } = createDeps({ canonicalKey: '/canonical', project })
  lifecycle.advance()
  lifecycle.advance()
  const admission = createPromptRunAdmission(deps)
  const target = admission.resolveTarget(input())

  assert.equal(target.runSessionKey, '/canonical')
  assert.equal(target.runSessionGeneration, 2)
  assert.equal(target.runLifecycle, lifecycle)
  assert.equal(target.normalizedText, 'hello')
  assert.equal(target.automaticModelSelection, true)
  assert.equal(target.project, project)
  assert.equal(target.runSnapshot.cwd, '/work')
})

test('plan mode rejects a remote project or a remote anchor path', () => {
  const remoteProject = {
    ...project,
    location: { kind: 'ssh', hostProfileId: 'host-1', remoteRoot: '/r', canonicalRoot: '/c' }
  } satisfies Project

  assert.throws(
    () =>
      createPromptRunAdmission(createDeps({ project: remoteProject }).deps).resolveTarget(
        input({ planMode: true })
      ),
    /远程项目暂不支持计划评审/
  )
  assert.throws(
    () =>
      createPromptRunAdmission(createDeps({ remoteAnchor: true }).deps).resolveTarget(
        input({ planMode: true })
      ),
    /远程项目暂不支持计划评审/
  )
})

test('admitPromptRun binds the Phi identity and rejects recovery, compaction, or an active run', () => {
  const target = createPromptRunAdmission(createDeps().deps).resolveTarget(input())

  assert.throws(
    () => createPromptRunAdmission(createDeps({ recovering: true }).deps).admit(target),
    /会话正在恢复/
  )
  assert.throws(
    () => createPromptRunAdmission(createDeps({ compacting: true }).deps).admit(target),
    /上下文压缩正在进行/
  )
  assert.throws(
    () => createPromptRunAdmission(createDeps({ hasActiveRun: true }).deps).admit(target),
    /会话正在运行/
  )

  const admitted = createPromptRunAdmission(createDeps().deps).admit(target)
  assert.equal(admitted.phiSessionId, 'phi-1')
  assert.equal(admitted.stableSessionPath, '/phi/phi-1')
  assert.equal(admitted.runId, 'run-1')
})

test('admitPromptRun uses the image fallback title only when text is empty', () => {
  const { deps, calls } = createDeps()
  const admission = createPromptRunAdmission(deps)
  const withImage = input({
    text: '',
    images: [{ mimeType: 'image/png', data: 'AAAA' }]
  })

  admission.admit(admission.resolveTarget(withImage))
  assert.deepEqual(calls, ['ensure:图片'])
})
