import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getPhiEngine } from '../../src/main/agent/engine/in-process-engine'
import { REMOTE_OMP_MANIFEST } from '../../src/main/agent/engine/rpc/runtime-deployment'
import type { RemoteStartupDiagnostic } from '../../src/main/agent/engine/rpc/remote-startup-diagnostics'
import { loadRemoteAgentCatalog } from '../../src/main/agent/agents/remote-agent-service'
import { createRemoteProject } from '../../src/main/agent/projects'
import { saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { sshConfigHostId } from '../../src/shared/remoteHostProfile'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import {
  createAppRemoteSessionManager,
  installAppRemoteSessionRouting
} from '../../src/main/agent/remote-session-routing'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import { createPhiSession, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { startHostResultModel } from '../../tests/helpers/rpcHostResultModel'
import { DENY_WRITES, runnerApproval } from './approval'
import { classifyingReplyFor } from './provider'
import type { ApprovalPolicy, R8Application, RequestPurposes } from './application-types'
import type { SshR8Workspace } from './ssh-workspace'
import { INSPECTOR_AGENT, type R8Input } from './types'

const PROVIDER_ID = 't16-r8-provider'
const MODEL_ID = 'fixture-model'

const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Local-only synthetic auth: a throwaway key stored in the private agent dir. */
async function seedSyntheticAuth(bun: string, agentDir: string): Promise<void> {
  const seed = spawn(
    bun,
    [
      '-e',
      `import {discoverAuthStorage} from '@oh-my-pi/pi-coding-agent';const auth=await discoverAuthStorage(${JSON.stringify(agentDir)});await auth.credentials.set(${JSON.stringify(PROVIDER_ID)},{type:'api_key',key:'synthetic-r8-key'});auth.close();`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  seed.stdout.resume()
  seed.stderr.resume()
  assert.equal(
    await new Promise((resolve, reject) => {
      seed.once('error', reject)
      seed.once('close', resolve)
    }),
    0,
    'Synthetic auth seed failed'
  )
}

async function writePrivateConfiguration(
  input: R8Input,
  agentDir: string,
  providerUrl: string
): Promise<void> {
  await writeFile(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      compaction: {
        enabled: false,
        thresholdPercent: 90,
        thresholdTokens: -1,
        methodOrder: ['soft']
      }
    }),
    { mode: 0o600, flag: 'wx' }
  )
  await mkdir(join(agentDir, 'agents'), { mode: 0o700 })
  await mkdir(join(input.localRoot, 'empty-bundled-agents'), { mode: 0o700 })
  await writeFile(
    join(agentDir, `agents/${INSPECTOR_AGENT}.md`),
    `---\nname: ${INSPECTOR_AGENT}\ndescription: Inspect one bounded file\ntools: [read]\n---\nPRIVATE_R8_INSPECTOR. Read only the explicitly requested file; report its marker and finish. Do not delegate.\n`,
    { mode: 0o600, flag: 'wx' }
  )
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        [PROVIDER_ID]: {
          api: 'openai-completions',
          auth: 'oauth',
          baseUrl: providerUrl,
          models: [
            {
              id: MODEL_ID,
              name: 'Synthetic R8 workflow',
              reasoning: true,
              input: ['text'],
              contextWindow: 65536,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    }),
    { mode: 0o600, flag: 'wx' }
  )
}

/** The real application composition against a real SSH host, with a loopback synthetic model. */
export async function createSshApplication(
  input: R8Input,
  remote: SshR8Workspace
): Promise<R8Application> {
  const agentDir = join(input.localRoot, 'agent')
  const bun = join(input.localRoot, 'home/.bun/bin/bun')
  await mkdir(join(input.localRoot, 'home/.bun/bin'), { recursive: true, mode: 0o700 })
  await writeFile(
    bun,
    `#!/bin/sh\nexec ${q(input.realBun)} --no-env-file --preload ${q(join(input.repoRoot, 'tests/engine-contract/network-guard.ts'))} "$@"\n`,
    { mode: 0o700, flag: 'wx' }
  )
  process.env.PHI_BUN_PATH = bun

  const purposes: RequestPurposes = { root: 0, child: 0, summary: 0 }
  const startupReports: RemoteStartupDiagnostic[] = []
  const provider = await startHostResultModel({ replyFor: classifyingReplyFor(purposes) })
  let uninstall: (() => void) | undefined
  let engine: ReturnType<typeof getPhiEngine> | undefined
  try {
    await writePrivateConfiguration(input, agentDir, provider.url)
    await seedSyntheticAuth(bun, agentDir)
    // Host discovery and project lookup both read the child's private HOME. Keep the
    // ssh-config profile id resolvable by writing the config where OpenSSH looks.
    const sshConfig = join(input.localRoot, 'home/.ssh/config')
    await mkdir(join(input.localRoot, 'home/.ssh'), { recursive: true, mode: 0o700 })
    await writeFile(sshConfig, `Host ${input.profile.hostAlias}\n`, { mode: 0o600, flag: 'wx' })
    const profile = saveRemoteHostProfile(
      {
        id: sshConfigHostId(input.profile.hostAlias),
        label: `Private R8 ${input.host}`,
        ...input.profile
      },
      agentDir,
      sshConfig
    )
    const project = await createRemoteProject(
      {
        name: `Private R8 ${input.host}`,
        hostProfileId: profile.id,
        remoteRoot: remote.projectRoot,
        permissionMode: 'ask'
      },
      { connectImpl: remote.connect }
    )
    assert.equal(project.location.kind, 'ssh')
    if (project.location.kind !== 'ssh') throw new Error('A remote project is required')
    assert.equal(project.location.canonicalRoot, remote.projectRoot)
    const location = project.location
    const anchor = ensureRemoteProjectAnchor(project.id, agentDir)
    // A remote effect must never be confused with a desktop fallback: the local anchor keeps this.
    await writeFile(join(anchor, 'input.txt'), 'LOCAL_ANCHOR_SENTINEL', { mode: 0o600, flag: 'wx' })
    const runners = new SessionRunnerRegistry()
    engine = getPhiEngine()
    const snapshot = await engine.models.snapshot({ agentDir })
    const model = snapshot.models.find((m) => m.provider === PROVIDER_ID && m.id === MODEL_ID)
    assert.ok(model, 'Trusted synthetic model missing')

    let policy: ApprovalPolicy = DENY_WRITES
    const binding = (identity: {
      sessionId: string
      projectId: string
    }): ReturnType<typeof resolveRemoteWorkspaceHostBinding> => {
      const resolved = resolveRemoteWorkspaceHostBinding(identity)
      assert.equal(resolved.hostAlias, input.host)
      assert.equal(resolved.canonicalRoot, remote.projectRoot)
      return { ...resolved, config: { ...resolved.config, connect: remote.connect } }
    }
    uninstall = installAppRemoteSessionRouting(
      {
        enabled: true,
        agentDir,
        runners,
        startupDiagnostics: (report) => startupReports.push(report),
        appPaths: () => ({
          appPath: input.repoRoot,
          resourcesPath: join(input.repoRoot, 'resources'),
          isPackaged: false
        }),
        configuredRoot: () => input.runtimeRoot,
        foregroundAgentNames: INSPECTOR_AGENT,
        loadAgents: async (identity) => {
          const loaded = await loadRemoteAgentCatalog(
            { ...identity, agentDir, bundledDir: join(input.localRoot, 'empty-bundled-agents') },
            { resolveBinding: binding, createHost: (bound) => new SshHost(bound.config) }
          )
          const selected = loaded.agents.filter((agent) => agent.name === INSPECTOR_AGENT)
          assert.equal(selected.length, 1, 'The private agent catalog must load the definition')
          assert.equal(selected[0].filePath, join(agentDir, `agents/${INSPECTOR_AGENT}.md`))
          assert.deepEqual(selected[0].tools, ['read'])
          return selected
        },
        approval: runnerApproval(runners, () => policy)
      },
      // Binding only: workspace opening and deployment keep their production defaults, so
      // startup installs whatever is missing on the server through the normal path.
      { resolveBinding: binding }
    )

    const createNewSession = (): { sessionId: string } =>
      createPhiSession({
        kind: 'project',
        projectId: project.id,
        projectLocation: location,
        cwd: anchor,
        cwdRealPath: anchor,
        permissionMode: 'ask',
        model: { providerId: PROVIDER_ID, modelId: MODEL_ID },
        thinkingLevel: 'high'
      })
    const attachSession: R8Application['attach'] = async (phiSessionId, resume) => {
      const saved = findPhiSessionById(phiSessionId)
      assert.ok(saved?.model)
      const at = performance.now()
      const created = await createRuntimeAgentSession({
        cwd: anchor,
        agentDir,
        model,
        thinkingLevel: 'high',
        ...(saved.autoCompaction ? { autoCompaction: saved.autoCompaction } : {}),
        projectBound: true,
        sessionManager: createAppRemoteSessionManager(anchor, phiSessionId, resume),
        remoteProject: { phiSessionId, projectId: project.id, location, contextFiles: [] }
      })
      remote.metrics.push({
        kind: resume ? 'app-explicit-resume-ready' : 'app-create-ready',
        elapsedMs: performance.now() - at
      })
      return created
    }

    let closing: Promise<void> | undefined
    return {
      runners,
      provider,
      projectId: project.id,
      anchor,
      purposes,
      startupReports,
      ompVersion: REMOTE_OMP_MANIFEST.version,
      async prepare() {
        const { session } = await attachSession(createNewSession().sessionId, false)
        await session.dispose()
      },
      create: createNewSession,
      attach: attachSession,
      approval(value) {
        policy = value
      },
      close() {
        return (closing ??= (async () => {
          uninstall?.()
          let primary: unknown
          try {
            await engine!.stop()
          } catch (error) {
            primary = error
          }
          const [result] = await Promise.allSettled([provider.close()])
          if (primary) throw primary
          if (result.status === 'rejected') throw result.reason
        })())
      }
    }
  } catch (error) {
    uninstall?.()
    const cleanup = await Promise.allSettled([...(engine ? [engine.stop()] : []), provider.close()])
    const failures = cleanup.flatMap((item) => (item.status === 'rejected' ? [item.reason] : []))
    if (failures.length)
      throw new AggregateError([error, ...failures], 'R8 application setup cleanup failed', {
        cause: error
      })
    throw error
  }
}
