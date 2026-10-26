import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

import {
  launchRemoteKernel,
  probeRemoteKernelHostProfile
} from '../../src/main/agent/engine/kernel-client/remote'
import { KernelSessionFactory } from '../../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../../src/main/agent/engine/session-routing-engine'
import type { PhiEngine, PhiSessionCreateParams } from '../../src/main/agent/engine/types'
import type { ModelAccessConfigureParams } from '../../src/shared/kernel-protocol'
import {
  connectRemoteSshSession,
  shellQuote
} from '../../src/main/agent/wrappers/remote-ssh-session'
import {
  MODEL_DESCRIPTOR,
  MODEL_ID,
  PROVIDER_ID,
  startLoopbackProvider
} from '../kernel-e2e/harness'
import { prepareKernelE2eRemoteHelper } from '../kernel-e2e/prepare-remote-helper'
import { shutdownSshScenarioKernel } from '../kernel-e2e/ssh-kernel-cleanup'
import type { CandidateContext } from '../kernel-candidate'
import {
  evaluateKernelPerfBudget,
  fourSessionWorkload,
  K0_LEGACY_WORKLOAD,
  percentileSummary,
  type KernelPerfReport
} from '../kernel-perf'
import type { PerfCliOptions } from './runner'
import {
  PeakTreeSampler,
  remoteProcessTree,
  selectRemoteKernelPid,
  type ProcessSample
} from './process-tree'

function unusedLegacyEngine(): PhiEngine {
  const unsupported = async (): Promise<never> => {
    throw new Error('Legacy execution was used by remote kernel performance.')
  }
  return {
    host: { register: () => () => undefined },
    sessions: { has: () => false },
    events: {
      onSessionEvent: () => () => undefined,
      onSessionState: () => () => undefined,
      onToolApproval: () => () => undefined
    },
    decisions: { models: async () => [], evaluate: unsupported },
    agentRuns: { list: async () => [] },
    shellJobs: { list: async () => [] },
    stop: async () => undefined
  } as unknown as PhiEngine
}

function k0Baseline(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      memory?: Array<{ after?: Record<string, { totalMb?: number }> }>
    }
    const values = (parsed.memory ?? [])
      .map((entry) => entry.after?.['4']?.totalMb)
      .filter((value): value is number => typeof value === 'number')
    return values.length ? Math.max(...values) : null
  } catch {
    return null
  }
}

function remoteMcpScript(): string {
  return `#!/bin/sh
printf '%s\n' "$$" > "$1"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"phi-a20","version":"1"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"candidate_ping","description":"A20 fixture","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}]}}\n' "$id" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done
`
}

function modelAccess(tunnel: { remotePort: number }, token: string): ModelAccessConfigureParams {
  return {
    endpoint: `http://127.0.0.1:${tunnel.remotePort}/v1/pi/stream`,
    bearerToken: token,
    models: [MODEL_DESCRIPTOR]
  }
}

function remoteParams(input: {
  id: string
  project: string
  desktopAgentDir: string
  host: string
  mcpScript?: string
  mcpPidPath?: string
}): PhiSessionCreateParams {
  return {
    sessionId: input.id,
    cwd: input.project,
    agentDir: input.desktopAgentDir,
    model: { provider: PROVIDER_ID, id: MODEL_ID, name: 'A20 loopback', reasoning: false },
    sessionManager: { kind: 'memory', cwd: input.project },
    enableToolApproval: false,
    autoCompaction: { enabled: false },
    resourceOptions: {
      noExtensions: true,
      noSkills: input.mcpScript === undefined,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    },
    ...(input.mcpScript
      ? {
          mcpServers: [
            {
              name: `candidate-${input.id}`,
              config: {
                type: 'stdio',
                command: '/bin/sh',
                args: [input.mcpScript, input.mcpPidPath!],
                cwd: input.project
              }
            }
          ]
        }
      : {}),
    remoteProject: {
      phiSessionId: `phi-${input.id}`,
      projectId: 'candidate-perf',
      location: {
        kind: 'ssh',
        hostProfileId: `ssh-config:${input.host}`,
        remoteRoot: input.project,
        canonicalRoot: input.project
      },
      contextFiles: []
    }
  }
}

async function verifiedRemoteMcpPids(
  paths: readonly string[],
  processTree: readonly ProcessSample[],
  run: (command: string) => Promise<{ stdout: string; stderr: string; code: number | null }>
): Promise<number> {
  const result = await run(`cat -- ${paths.map(shellQuote).join(' ')}`)
  if (result.code !== 0) throw new Error(result.stderr || 'remote MCP PID files were unavailable')
  const pids = result.stdout.split(/\s+/u).filter(Boolean).map(Number)
  if (pids.length !== paths.length || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`Remote MCP PID evidence was invalid: ${JSON.stringify(result.stdout)}.`)
  }
  const descendants = new Set(processTree.map((process) => process.pid))
  const missing = pids.filter((pid) => !descendants.has(pid))
  if (missing.length > 0) {
    throw new Error(
      `Remote stdio MCP PIDs were absent from the kernel process tree: ${missing.join(', ')}.`
    )
  }
  return pids.length
}

function configureFactory(factory: KernelSessionFactory): void {
  factory.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
  factory.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
}

export async function runRemoteKernelPerformance(input: {
  cli: PerfCliOptions
  context: CandidateContext
  versions: { phi: string; omp: string; native: string }
  repoRoot: string
}): Promise<KernelPerfReport> {
  const { cli, context, versions, repoRoot } = input
  const host = cli.host!
  const runtimeRoot = posix.normalize(
    cli.runtimeRoot ?? `/tmp/phi-k4-2-perf-${context.candidateId}`
  )
  if (!posix.isAbsolute(runtimeRoot) || runtimeRoot === '/' || /[\0\r\n]/u.test(runtimeRoot)) {
    throw new Error('--runtime-root must be a safe absolute remote path.')
  }
  const token = randomBytes(32).toString('base64url')
  const provider = await startLoopbackProvider(token)
  const ssh = await connectRemoteSshSession({ host, userInitiated: true })
  let tunnel: Awaited<ReturnType<NonNullable<typeof ssh.openReverseTunnel>>> | undefined
  const remaining = new Set<number>()
  const run = (command: string): ReturnType<typeof ssh.exec> => ssh.exec(command)
  try {
    const profile = await probeRemoteKernelHostProfile(ssh, AbortSignal.timeout(30_000))
    await prepareKernelE2eRemoteHelper({
      session: ssh,
      profile,
      hostAlias: host,
      runtimeRoot,
      signal: AbortSignal.timeout(180_000)
    })
    if (!ssh.openReverseTunnel) throw new Error('SSH transport lacks reverse tunnel support.')
    tunnel = await ssh.openReverseTunnel({ localPort: provider.port })
    const runRoot = posix.join(runtimeRoot, 'candidate-perf', randomUUID())
    const project = posix.join(runRoot, 'project')
    const home = posix.join(runRoot, 'home')
    const agentDir = posix.join(runRoot, 'agent')
    const mcpScript = posix.join(runRoot, 'candidate-mcp.sh')
    const prepared = await run(
      `umask 077; mkdir -p -- ${[
        project,
        home,
        agentDir,
        posix.join(project, '.phi/skills/candidate-perf')
      ]
        .map(shellQuote)
        .join(
          ' '
        )}; i=0; while [ "$i" -lt ${cli.projectFiles} ]; do d=${shellQuote(project)}/group-$((i / 100)); mkdir -p -- "$d"; printf 'candidate %s\n' "$i" > "$d/file-$i.txt"; i=$((i + 1)); done`
    )
    if (prepared.code !== 0) throw new Error(prepared.stderr || 'remote project preparation failed')
    await ssh.writeTextFile(mcpScript, remoteMcpScript())
    await ssh.writeTextFile(
      posix.join(project, '.phi/skills/candidate-perf/SKILL.md'),
      '# Candidate perf\n\nRead-only fixture skill for A20.\n'
    )
    const buildDirectory =
      cli.buildDirectory ?? posix.join(repoRoot, '.phi-build', 'kernel', versions.phi, 'linux-x64')

    const launchFactory = (
      onLaunch: (launch: Awaited<ReturnType<typeof launchRemoteKernel>>) => void
    ): KernelSessionFactory => {
      const factory = new KernelSessionFactory({
        mode: 'remote',
        launchRemote: async (_params, launchContext, signal) => {
          const launched = await launchRemoteKernel({
            session: ssh,
            profile,
            runtimeRoot,
            buildDirectory,
            home,
            agentDir,
            graceMs: 250,
            configureClient: launchContext.configureClient,
            hello: { hostCapabilities: [...launchContext.hostCapabilities] },
            modelAccess: modelAccess(tunnel!, token),
            signal
          })
          onLaunch(launched)
          return {
            client: launched.client,
            greeting: launched.greeting,
            runtimeRoot: launched.deployment.runtimeRoot,
            configuredBeforeHello: true,
            close: async () => {
              await launched.close()
            }
          }
        }
      })
      configureFactory(factory)
      return factory
    }

    const kernelReady: number[] = []
    const sessionReady: number[] = []
    const readyOnce = async (record: boolean, index: number): Promise<void> => {
      let launched: Awaited<ReturnType<typeof launchRemoteKernel>> | undefined
      const factory = launchFactory((value) => {
        launched = value
      })
      const engine = new SessionRoutingEngine(unusedLegacyEngine(), () => factory)
      const started = performance.now()
      try {
        await engine.sessions.create(
          remoteParams({
            id: `remote-ready-${record ? 'sample' : 'warmup'}-${index}`,
            project,
            desktopAgentDir: resolve('.phi-acceptance/perf-desktop-agent'),
            host
          })
        )
        if (record) {
          kernelReady.push(launched!.readyMs)
          sessionReady.push(performance.now() - started)
        }
      } finally {
        await engine.stop().catch(() => undefined)
        if (launched) {
          const pid = selectRemoteKernelPid({
            runtimePid: launched.greeting.runtime.pid,
            ...(launched.attach.state === 'spawned' ? { helperPid: launched.attach.pid } : {})
          })
          remaining.add(pid)
          await shutdownSshScenarioKernel({ session: ssh, launch: launched }).catch(() => undefined)
          remaining.delete(pid)
        }
      }
    }
    await readyOnce(false, 0)
    for (let index = 0; index < cli.readySamples; index += 1) await readyOnce(true, index)

    const workloads: KernelPerfReport['workloads'][number][] = []
    for (const count of [1, 4] as const) {
      let launched: Awaited<ReturnType<typeof launchRemoteKernel>> | undefined
      let sampler: PeakTreeSampler | undefined
      let kernelPid: number | undefined
      const factory = launchFactory((value) => {
        launched = value
        kernelPid = selectRemoteKernelPid({
          runtimePid: value.greeting.runtime.pid,
          ...(value.attach.state === 'spawned' ? { helperPid: value.attach.pid } : {})
        })
        remaining.add(kernelPid)
        sampler = new PeakTreeSampler(() => remoteProcessTree(kernelPid!, run), kernelPid, 100)
        sampler.start()
      })
      const engine = new SessionRoutingEngine(unusedLegacyEngine(), () => factory)
      const modelTimes: number[] = []
      let activeProcessTree: readonly ProcessSample[] = []
      let mcpSessionsVerified = 0
      try {
        for (let round = 0; round < cli.rounds; round += 1) {
          const ids = Array.from(
            { length: count },
            (_, index) => `remote-load-${count}-${round}-${index}`
          )
          const mcpPidPaths = ids.map((id) => posix.join(runRoot, `${id}.mcp.pid`))
          await Promise.all(
            ids.map((id, index) =>
              engine.sessions.create(
                remoteParams({
                  id,
                  project,
                  desktopAgentDir: resolve('.phi-acceptance/perf-desktop-agent'),
                  host,
                  mcpScript,
                  mcpPidPath: mcpPidPaths[index]
                })
              )
            )
          )
          await sampler!.once()
          const roundProcessTree = [...sampler!.latest]
          mcpSessionsVerified += await verifiedRemoteMcpPids(mcpPidPaths, roundProcessTree, run)
          if (roundProcessTree.length > activeProcessTree.length) {
            activeProcessTree = roundProcessTree
          }
          provider.enqueue(...ids.map((id) => ({ text: `remote A20 ${id}` })))
          await Promise.all(
            ids.map(async (id) => {
              const started = performance.now()
              await engine.sessions.prompt({ sessionId: id, text: 'Remote A20 loopback turn.' })
              modelTimes.push(performance.now() - started)
            })
          )
          await sampler!.once()
          await Promise.all(ids.map((id) => engine.sessions.dispose({ sessionId: id })))
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
        const idle = await sampler!.once()
        const idleProcessTree = [...sampler!.latest]
        await sampler!.stop()
        workloads.push({
          sessions: count,
          rounds: cli.rounds,
          peakRssMb: Math.round(sampler!.peakMb * 10) / 10,
          idleReleasedRssMb: idle,
          modelNetworkMs: percentileSummary(modelTimes),
          processTree: sampler!.peakTree,
          activeProcessTree,
          idleProcessTree,
          mcpSessionsVerified
        })
      } finally {
        await sampler?.stop().catch(() => undefined)
        await engine.stop().catch(() => undefined)
        if (launched) {
          await shutdownSshScenarioKernel({ session: ssh, launch: launched }).catch(() => undefined)
          if (kernelPid !== undefined) remaining.delete(kernelPid)
        }
      }
    }
    const cleanup = await run(`rm -rf -- ${shellQuote(runRoot)}`)
    if (cleanup.code !== 0) throw new Error(cleanup.stderr || 'remote fixture cleanup failed')
    const baseline = k0Baseline(
      cli.baseline ??
        resolve(repoRoot, '..', '..', 'Phi', '.phi-acceptance/k0-2/perf/result-659fcf9d.json')
    )
    const fourSessionPeak = workloads.find((item) => item.sessions === 4)?.peakRssMb ?? undefined
    const ready = {
      definition:
        'SessionRoutingEngine remote create start → SSH/helper kernel hello; and → first memory session snapshot, after one unrecorded prewarm',
      warm: true as const,
      kernel: percentileSummary(kernelReady),
      firstSession: percentileSummary(sessionReady)
    }
    return {
      schemaVersion: 1,
      candidateId: context.candidateId,
      target: 'ssh',
      host,
      measuredAt: new Date().toISOString(),
      machine: {
        os: `${profile.platform.os} ${profile.platform.libc?.name ?? ''} ${profile.platform.libc?.version ?? ''}`.trim(),
        arch: profile.platform.arch,
        node: 'not used (compiled remote kernel)',
        bun: `compiled with ${(process.versions as Record<string, string | undefined>).bun ?? 'unknown'}`
      },
      versions,
      project: { files: cli.projectFiles, skills: true, stdioMcpPerSession: true },
      ready,
      workloads,
      legacy: {
        k0BaselineMb: baseline,
        k0Workload: K0_LEGACY_WORKLOAD,
        sameRunFourSessionMb: null,
        sameRunWorkload: fourSessionWorkload(cli.projectFiles, cli.rounds),
        sameRunFailure:
          'Not run for an SSH target because the legacy route executes on the desktop host.',
        sameRunProcessTree: [],
        sameRunMcpSessionsVerified: 0
      },
      budgets: evaluateKernelPerfBudget({
        ...(fourSessionPeak === undefined ? {} : { fourSessionPeakMb: fourSessionPeak }),
        ...(baseline === null ? {} : { legacyBaselineMb: baseline })
      }),
      cleanup: { complete: remaining.size === 0, remainingProcesses: [...remaining] }
    }
  } finally {
    await tunnel?.close().catch(() => undefined)
    await ssh.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
}
