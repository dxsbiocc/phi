import assert from 'node:assert/strict'

import type { KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import {
  reattachRemoteKernel,
  type LaunchedRemoteKernel
} from '../../src/main/agent/engine/kernel-client/remote'
import type { RemoteSshSession } from '../../src/main/agent/wrappers/remote-ssh-session'

export const KERNEL_E2E_HOST_CAPABILITIES = [
  'settings.nextActionSuggestionsEnabled',
  'skills.scriptTools',
  'workMode.selected',
  'planReview.request'
] as const

type LifecycleScenario = 'reconnect' | 'grace-expiry'

interface ScriptedReply {
  text?: string
  tool?: { name: string; id: string; args: Record<string, unknown> }
}

interface LifecycleFiles {
  readonly paths: {
    readonly projectA: string
    readonly childPidFile: string
  }
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  processAlive(pid: number): Promise<boolean>
}

export interface LifecycleScenarioClient {
  readonly lastSeen: number
  create(cwd: string, approval: boolean): Promise<string>
  prompt(sessionId: string, text: string): Promise<{ runId: string; status: string }>
  startPrompt(sessionId: string, text: string): Promise<string>
  snapshot(sessionId: string): Promise<Record<string, unknown>>
  waitForRun(runId: string): Promise<{ status: string; detail?: string }>
  hasCompleted(runId: string): boolean
  close(): void
}

interface LifecycleReportProjection {
  readonly deploy: { reattachRemoteCommandCount?: number }
  readonly evidence: {
    kernelPidA?: number
    longChildPid?: number
    reconnectedKernelPid?: number
  }
}

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

export function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  return typeof item.text === 'string' ? item.text : contentText(item.content)
}

export function toolEvidence(snapshot: Record<string, unknown>, toolName: string): string {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  return messages
    .filter((message): message is Record<string, unknown> =>
      Boolean(
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === 'toolResult' &&
        (message as Record<string, unknown>).toolName === toolName
      )
    )
    .map((message) => contentText(message.content))
    .join('\n')
}

export function extractKernelPid(text: string): number {
  const match = text.match(/KERNEL_PID=(\d+)/)
  const pid = Number(match?.[1])
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `Missing kernel PID evidence: ${text}`)
  return pid
}

export async function runSshLifecycleScenario<T extends LifecycleScenarioClient>(options: {
  scenario: LifecycleScenario
  session: Pick<RemoteSshSession, 'openStdio'>
  launch: LaunchedRemoteKernel
  client: T
  createClient(client: KernelProtocolClient): T
  /** Re-sends desktop-owned configuration after each hello, as the desktop does. */
  afterReattach?(client: KernelProtocolClient): Promise<void>
  provider: { enqueue(...replies: ScriptedReply[]): void }
  files: LifecycleFiles
  report: LifecycleReportProjection
  step: Step
  onDiagnostic(text: string): void
}): Promise<{ remoteLaunch?: LaunchedRemoteKernel; scenario?: T }> {
  let scenario = options.client
  const sessionId = await options.step('lifecycle session created', () =>
    scenario.create(options.files.paths.projectA, false)
  )
  options.provider.enqueue(
    {
      tool: {
        name: 'bash',
        id: 'lifecycle-identity-before',
        args: { command: 'printf \'KERNEL_PID=%s\' "$$"' }
      }
    },
    { text: 'LIFECYCLE_IDENTITY_READY' }
  )
  await options.step('kernel identity captured before disconnect', async () => {
    const completion = await scenario.prompt(sessionId, 'Capture the kernel identity.')
    assert.equal(completion.status, 'completed')
    options.report.evidence.kernelPidA = extractKernelPid(
      toolEvidence(await scenario.snapshot(sessionId), 'bash')
    )
  })
  const kernelPid = options.report.evidence.kernelPidA
  if (kernelPid === undefined) throw new Error('Lifecycle scenario omitted kernel PID')

  options.provider.enqueue(
    {
      tool: {
        name: 'bash',
        id: 'lifecycle-long-child',
        args: {
          command: `sh -c 'printf "%s" "$$" > "$1"; exec sleep ${
            // Long enough to outlast slow SSH pidfile reads, so the run spans the drop.
            options.scenario === 'reconnect' ? '8' : '60'
          }' sh ${shellLiteral(options.files.paths.childPidFile)}`
        }
      }
    },
    ...(options.scenario === 'reconnect' ? ([{ text: 'LIFECYCLE_LONG_COMPLETE' }] as const) : [])
  )
  const runId = await options.step('long lifecycle run accepted', () =>
    scenario.startPrompt(sessionId, 'Run the lifecycle long command.')
  )
  await options.step('long lifecycle child started', () =>
    eventually(
      async () =>
        (await options.files.exists(options.files.paths.childPidFile)) &&
        (await options.files.read(options.files.paths.childPidFile)).trim().length > 0,
      'lifecycle child pidfile'
    )
  )
  const childPid = Number((await options.files.read(options.files.paths.childPidFile)).trim())
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
  options.report.evidence.longChildPid = childPid
  const lastSeen = scenario.lastSeen
  if (options.scenario === 'reconnect' && scenario.hasCompleted(runId)) {
    throw new Error('The long run finished before the disconnect; reconnect was not exercised.')
  }
  scenario.close()
  await options.step('remote helper channel dropped', () => options.launch.close())

  if (options.scenario === 'grace-expiry') {
    await options.step('grace expiry stopped kernel and native child', () =>
      eventually(
        async () =>
          !(await options.files.processAlive(kernelPid)) &&
          !(await options.files.processAlive(childPid)),
        'kernel and child exit after grace expiry'
      )
    )
    return {}
  }

  let resumedScenario: T | undefined
  const reattached = await options.step('remote kernel reattached with takeover and replay', () =>
    reattachRemoteKernel({
      session: options.session,
      previous: options.launch,
      lastSeen,
      signal: AbortSignal.timeout(60_000),
      hello: { hostCapabilities: [...KERNEL_E2E_HOST_CAPABILITIES] },
      configureClient(client) {
        resumedScenario = options.createClient(client)
      },
      onDiagnostic: options.onDiagnostic
    })
  )
  assert.equal(reattached.snapshotRequired, false)
  assert.equal(reattached.attach.state, 'attached')
  assert.equal(reattached.greeting.kernelInstanceId, options.launch.greeting.kernelInstanceId)
  options.report.deploy.reattachRemoteCommandCount = reattached.remoteCommandCount
  if (!resumedScenario) throw new Error('Reconnect did not configure the scenario client')
  scenario = resumedScenario
  await options.afterReattach?.(reattached.client)

  await options.step('run completion replayed after reconnect', async () => {
    const completion = await scenario.waitForRun(runId)
    assert.equal(completion.status, 'completed')
  })
  options.provider.enqueue(
    {
      tool: {
        name: 'bash',
        id: 'lifecycle-identity-after',
        args: { command: 'printf \'KERNEL_PID=%s\' "$$"' }
      }
    },
    { text: 'LIFECYCLE_RECONNECTED' }
  )
  await options.step('reconnect retained the same kernel process', async () => {
    const completion = await scenario.prompt(sessionId, 'Capture the kernel identity again.')
    assert.equal(completion.status, 'completed')
    options.report.evidence.reconnectedKernelPid = extractKernelPid(
      toolEvidence(await scenario.snapshot(sessionId), 'bash')
    )
    assert.equal(options.report.evidence.reconnectedKernelPid, kernelPid)
  })
  return { remoteLaunch: reattached, scenario }
}
