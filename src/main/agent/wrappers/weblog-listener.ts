import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getPhiAgentDir } from '../runtime-paths'
import { appendWrapperRunEvent, readWrapperRun, writeWrapperRun } from './store'
import type { WrapperManifestStep } from './manifest-types'
import type { WrapperStepState } from './types'

interface NextflowWeblogTrace {
  process?: string
  name?: string
  status?: string
}

interface NextflowWeblogPayload {
  event?: string
  trace?: NextflowWeblogTrace
}

/**
 * Matches a Nextflow process/trace name against the manifest's declared
 * `steps[].id`. Nextflow's `trace.name` is often "processName (tag)" for a
 * per-sample task — strip the tag before comparing. See technical design's
 * "Workflow Structure And Live Run State".
 */
function resolveStepId(
  steps: WrapperManifestStep[],
  candidate: string | undefined
): string | undefined {
  if (!candidate) return undefined
  const normalized = candidate.trim().toLowerCase()
  const base = normalized.split('(')[0].trim()
  return steps.find((step) => {
    const id = step.id.toLowerCase()
    return id === normalized || id === base
  })?.id
}

function stepStateFromEvent(payload: NextflowWeblogPayload): WrapperStepState | undefined {
  if (payload.event === 'process_submitted' || payload.event === 'process_started') return 'running'
  if (payload.event === 'process_completed') {
    const status = payload.trace?.status?.toUpperCase()
    return status === 'FAILED' || status === 'ERROR' ? 'failed' : 'completed'
  }
  return undefined
}

/**
 * Applies one Nextflow weblog event to the run's persisted `stepStates`.
 * Never fabricates a step state for a process name that doesn't match any
 * declared step — an unresolved process name is silently dropped, leaving
 * the diagram to fall back to its default per-step state (`pending`) and
 * the run's overall state for anything not individually tracked.
 */
export function applyWeblogEvent(
  runId: string,
  steps: WrapperManifestStep[],
  payload: NextflowWeblogPayload,
  agentDir: string
): void {
  const stepState = stepStateFromEvent(payload)
  if (!stepState) return
  const stepId = resolveStepId(steps, payload.trace?.process ?? payload.trace?.name)
  if (!stepId) return

  const run = readWrapperRun(runId, agentDir)
  if (!run) return

  const timestamp = new Date().toISOString()
  writeWrapperRun(
    {
      ...run,
      stepStates: { ...(run.stepStates ?? {}), [stepId]: stepState },
      updatedAt: timestamp
    },
    agentDir
  )
  appendWrapperRunEvent(
    runId,
    { type: 'run_state_changed', timestamp, stepId, state: stepState },
    agentDir
  )
}

export interface WeblogListenerHandle {
  /** Pass as Nextflow's `-with-weblog <url>` argument. */
  url: string
  stop: () => Promise<void>
}

/**
 * Starts a short-lived local HTTP listener for one run's Nextflow
 * `-with-weblog` events. The listener only lives for the duration of that
 * run's local execution (Milestone P1.7) — this is not a persistent server.
 */
export function startWeblogListener(
  runId: string,
  steps: WrapperManifestStep[],
  agentDir: string = getPhiAgentDir()
): Promise<WeblogListenerHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200).end()
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString('utf-8')
          ) as NextflowWeblogPayload
          applyWeblogEvent(runId, steps, payload, agentDir)
        } catch {
          // Malformed weblog body — this is a monitoring side-channel, never let it fail the run.
        }
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}/weblog`,
        stop: () => new Promise<void>((res) => server.close(() => res()))
      })
    })
  })
}
