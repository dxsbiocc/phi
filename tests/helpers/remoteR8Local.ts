import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { runnerApproval } from '../../scripts/remote-r8/approval'
import type { ApprovalPolicy, R8Application } from '../../scripts/remote-r8/application-types'
import { observeAttestation } from '../../scripts/remote-r8/attestation-observer'
import { classifyingReplyFor } from '../../scripts/remote-r8/provider'
import { INSPECTOR_AGENT, bounded } from '../../scripts/remote-r8/types'
import type {
  DisconnectResult,
  R8Workspace,
  RpcGeneration,
  TimedOperation
} from '../../scripts/remote-r8/workspace'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import { REMOTE_OMP_MANIFEST } from '../../src/main/agent/engine/rpc/runtime-deployment'
import { findPhiSessionById } from '../../src/main/agent/session/session-store'
import { facadeMetadataFixture, type FacadeMetadataFixture } from './facadeMetadataFixture'
import { startHostResultModel } from './rpcHostResultModel'

const run = promisify(execFile)

const inspector: PhiAgentDefinition = {
  name: INSPECTOR_AGENT,
  description: 'Inspect one bounded file',
  tools: ['read'],
  skills: [],
  visibility: 'entry',
  warnings: [],
  source: 'phi',
  filePath: '/trusted-fixture/R8Inspector.md',
  systemPrompt:
    'PRIVATE_R8_INSPECTOR. Read only the explicitly requested file; report its marker and finish. Do not delegate.'
}

export interface LocalR8 {
  readonly fixture: FacadeMetadataFixture
  readonly workspace: R8Workspace
  readonly application: R8Application
}

/**
 * The R8 workspace and application over the local-shell facade fixture: the same cases and
 * cleanup run against a real OMP CLI and real production routing, with a local bash standing in
 * for the SSH host. Remote-only shell checks (GNU stat) are covered by the script-text tests.
 */
export async function createLocalR8(runId: string, bundleHash: string): Promise<LocalR8> {
  const purposes = { root: 0, child: 0, summary: 0 }
  const startupReports: R8Application['startupReports'] = []
  const fixture = await facadeMetadataFixture({
    isolatedProject: true,
    providerFactory: () => startHostResultModel({ replyFor: classifyingReplyFor(purposes) }),
    applicationRouting: {
      agents: [inspector],
      foregroundAgentNames: INSPECTOR_AGENT,
      startupDiagnostics: (report) => startupReports.push(report)
    }
  })
  const projectRoot = fixture.f.scope.projectRoot
  await writeFile(join(projectRoot, 'input.txt'), `R8_SEED_${runId}\n`, { mode: 0o600 })

  const anchor = fixture.params('anchor').cwd
  await writeFile(join(anchor, 'input.txt'), 'LOCAL_ANCHOR_SENTINEL', { mode: 0o600, flag: 'wx' })

  const rpc: RpcGeneration[] = []
  const generations: string[] = []
  const metrics: TimedOperation[] = []
  const openStdio = fixture.hostSession.openStdio!
  fixture.hostSession.openStdio = async (command) => {
    const openedAt = performance.now()
    const channel = await openStdio(command)
    if (command.includes("'--mode' 'rpc'")) {
      const record: RpcGeneration = { channel, openedAt }
      rpc.push(record)
      observeAttestation(record, channel, bundleHash, generations)
    }
    return channel
  }

  const workspace: R8Workspace = {
    projectRoot,
    runtimeRoot: fixture.f.runtimeRoot,
    rootCreated: false,
    rpc,
    generations,
    metrics,
    hasOpenChannels: () => rpc.length > 0,
    async command(script) {
      return (await run('bash', ['-c', script])).stdout
    },
    async tunnelCounts() {
      const closed = await Promise.all(
        fixture.tunnels.map((tunnel) =>
          Promise.race([
            tunnel.closed.then(() => 1),
            new Promise<number>((resolve) => setTimeout(() => resolve(0), 2000))
          ])
        )
      )
      return { opened: fixture.tunnels.length, closed: closed.reduce((a, b) => a + b, 0) }
    },
    async abruptDisconnectLatest(): Promise<DisconnectResult> {
      const owned = rpc.at(-1)
      if (!owned?.nonce) throw new Error('Only an attested RPC connection is killed')
      const at = performance.now()
      fixture.f.session.killLatestStdio('SIGKILL')
      await bounded(owned.channel.closed, 10_000, 'killed RPC channel physical close')
      return {
        transport: 'local-stdio',
        pid: null,
        signal: 'SIGKILL',
        physicalRpcClosed: true,
        elapsedMs: performance.now() - at
      }
    },
    async awaitRpcClosed() {
      await Promise.all(rpc.map((r) => bounded(r.channel.closed, 10_000, 'RPC physical close')))
    },
    async cleanupOwnedWork() {
      for (const name of ['input.txt', 'bash.txt'])
        await rm(join(projectRoot, name), { force: true })
    },
    async close() {
      await Promise.all(rpc.map((r) => bounded(r.channel.closed, 10_000, 'RPC physical close')))
    }
  }

  let policy: ApprovalPolicy = { shouldGate: () => false, requestToolApproval: () => 'denied' }
  fixture.configureApproval(runnerApproval(fixture.runners, () => policy))
  const sessionId = fixture.phi.sessionId
  let closing: Promise<void> | undefined
  const application: R8Application = {
    runners: fixture.runners,
    provider: fixture.provider,
    projectId: findPhiSessionById(sessionId)!.projectId!,
    anchor,
    purposes,
    startupReports,
    ompVersion: REMOTE_OMP_MANIFEST.version,
    async prepare() {
      const { session } = await application.attach(sessionId, false)
      await session.dispose()
    },
    create: () => ({ sessionId }),
    async attach(phiSessionId, resume) {
      if (phiSessionId !== sessionId) throw new Error('The local fixture owns one session')
      if (resume) fixture.resume()
      const at = performance.now()
      const created = await fixture.createApplicationSession()
      metrics.push({
        kind: resume ? 'app-explicit-resume-ready' : 'app-create-ready',
        elapsedMs: performance.now() - at
      })
      return created
    },
    approval(value) {
      policy = value
    },
    close() {
      // Everything the fixture's own close does except removing the runtime tree, which the
      // cleanup audit still has to inspect.
      return (closing ??= (async () => {
        fixture.disableRouting()
        await fixture.engine.stop()
        await Promise.all(fixture.tunnels.map((tunnel) => tunnel.close()))
        await fixture.provider.close()
      })())
    }
  }
  return { fixture, workspace, application }
}
