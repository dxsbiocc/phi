import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  findWrapperCompositionEntry,
  listWrapperCompositionCatalog,
  readWrapperDefaultParams
} from './discovery'
import { WRAPPER_EXECUTION_PROFILES } from './executor'
import { formatJobList, formatJobStatus } from './job-format'
import type { WrapperJobClient } from './job-types'
import { rankWrapperEntries } from './search'

/**
 * The generic, progressively-loaded `wrapper_*` tools described in
 * docs/design/phi-wrapper-agent-composition-design.md section 4 — search,
 * inspect, then run. Supersedes the older one-tool-per-bundled-wrapper
 * model in `../tools.ts` (`buildDefaultWrapperCustomTools`), which this
 * build's `omp-sdk-worker.ts` no longer wires in, to avoid two `wrapper_*`
 * tool sets registering the same names.
 *
 * `wrapper_run` executes directly (no separate plan/submit step) — the
 * plan-card chat UI from Milestone P1.5 was built for the older package
 * manifest and hasn't been ported to this layout yet.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildWrapperCompositionSearchTool(): CustomTool {
  return {
    name: 'wrapper_search',
    label: 'Search Wrappers',
    description:
      'Search available Nextflow module/subworkflow wrappers by keyword. Returns id, name, and summary. Use before wrapper_inspect.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to match against id, name, or summary, e.g. "rna seq alignment". Every word must match; if none does, the best partial matches are returned. Omit to list everything installed.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const query = isRecord(params) && typeof params.query === 'string' ? params.query : ''
      const outcome = rankWrapperEntries(listWrapperCompositionCatalog(), query)
      const results = outcome.entries.map((entry) => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        summary: entry.manifest.summary
      }))
      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching wrappers found.' }],
          details: { kind: 'wrapper_search_results', results }
        }
      }

      const content: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: JSON.stringify(results) }
      ]
      if (!outcome.matchedAll) {
        content.push({
          type: 'text',
          text: `Partial matches only: no wrapper matched every word. Nothing matched: ${outcome.unmatchedWords.join(', ') || '(each word matched some wrapper, none matched all)'}.`
        })
      }
      return { content, details: { kind: 'wrapper_search_results', results } }
    }
  }
}

export function buildWrapperCompositionInspectTool(): CustomTool {
  return {
    name: 'wrapper_inspect',
    label: 'Inspect Wrapper',
    description:
      'Get the params/outputs contract and default run parameters for one wrapper by id (from wrapper_search), so you know what to override before calling wrapper_run.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Wrapper id, e.g. "nf-core/modules/fastqc".' }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const id = isRecord(params) && typeof params.id === 'string' ? params.id : undefined
      if (!id) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: id' }],
          isError: true
        }
      }
      const entry = findWrapperCompositionEntry(id)
      if (!entry) {
        return { content: [{ type: 'text', text: `Wrapper not found: ${id}` }], isError: true }
      }
      const defaultParams = readWrapperDefaultParams(entry.wrapperDir)

      return {
        content: [{ type: 'text', text: JSON.stringify({ ...entry.manifest, defaultParams }) }],
        details: { kind: 'wrapper_manifest', manifest: entry.manifest, defaultParams }
      }
    }
  }
}

const DEFAULT_WAIT_SECONDS = 120
const MAX_WAIT_SECONDS = 600

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { ...textResult(text), isError: true }
}

function runIdParam(params: unknown): string | undefined {
  return isRecord(params) && typeof params.run_id === 'string' && params.run_id.trim()
    ? params.run_id.trim()
    : undefined
}

/** Starts a run in the background and returns at once with its run id. */
export function buildWrapperCompositionRunTool(jobs: WrapperJobClient): CustomTool {
  return {
    name: 'wrapper_run',
    label: 'Run Wrapper',
    description:
      'Start one wrapper by id in the BACKGROUND, merging the given parameter overrides into its default params.json, and return immediately with a run id. It launches a real Nextflow run that keeps going by itself; follow it with wrapper_status, block on it with wrapper_wait, stop it with wrapper_cancel. In an SSH project the target defaults to that project server and explicit "local" is rejected; in a local project the target defaults to local, and "remote" uses its saved server. For a remote run every kind:input path MUST be a path on the server (Phi checks it exists there; local paths do not work), outputs stay on the server, and it survives Phi being closed. Choose `profile` based on what the user has available or prefers: docker (default locally) or singularity (default on the server) for container runtimes, conda to build/reuse a conda environment from the module\'s environment.yml instead.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Wrapper id, e.g. "nf-core/modules/fastqc".' },
        params: {
          type: 'object',
          description:
            'Parameter overrides merged into defaults. An input may be a server path string or {"source":"remote","path":"/server/file"}; use {"source":"local","path":"/local/file"} only when this local project has a saved local-root→server-root mapping. Phi maps paths but does not upload data. Output and option values keep their ordinary types.'
        },
        target: {
          type: 'string',
          enum: ['local', 'remote'],
          description:
            'Omit to use the project location: SSH projects run on their bound server; local projects run locally. "local" is rejected in an SSH project. "remote" uses the project server or saved remote connection.'
        },
        profile: {
          type: 'string',
          enum: [...WRAPPER_EXECUTION_PROFILES],
          description:
            'Execution profile: "docker" or "singularity" run the tool in a container; "conda" builds/reuses a conda environment instead. Omit it to use the default (docker locally, the cluster connection\'s configured runtime remotely). Ask the user which is available if unsure — do not assume Docker is installed.'
        },
        continue_when_done: {
          type: 'boolean',
          description:
            'Default true: when the run ends, Phi wakes the main agent with the outcome so it can continue with the results. Set false only when the task says nothing should happen afterwards.'
        },
        resources: {
          type: 'object',
          description:
            'Compute resources for every process of this run, replacing the wrapper defaults, which are sized for tiny test data (often 2-4 CPUs, 4-6 GB, 1 h). Set them for real data, e.g. a mammalian genome: STAR index build or alignment needs about {"cpus": 8, "memory": "40 GB", "time": "8h"}; BWA/HISAT2 alignment {"cpus": 8, "memory": "16 GB", "time": "6h"}. Keep within what the target machine or cluster node has.',
          properties: {
            cpus: { type: 'integer', minimum: 1, description: 'CPUs per process.' },
            memory: {
              type: 'string',
              description: 'Memory per process with a unit, e.g. "40 GB".'
            },
            time: { type: 'string', description: 'Time limit per process, e.g. "4h" or "1d 6h".' }
          }
        }
      }
    },
    approval: 'write',
    async execute(_toolCallId, params) {
      const id = isRecord(params) && typeof params.id === 'string' ? params.id : undefined
      if (!id) return errorResult('Missing required parameter: id')
      const overrides = isRecord(params) && isRecord(params.params) ? params.params : {}
      const profile =
        isRecord(params) && typeof params.profile === 'string' ? params.profile : undefined
      const target =
        isRecord(params) && (params.target === 'remote' || params.target === 'local')
          ? params.target
          : undefined

      const continueWhenDone =
        isRecord(params) && params.continue_when_done === false ? false : undefined
      const resources = isRecord(params) ? params.resources : undefined
      const started = await jobs.start({
        id,
        overrides,
        ...(profile ? { profile } : {}),
        ...(target ? { target } : {}),
        ...(continueWhenDone === false ? { continueWhenDone } : {}),
        ...(resources !== undefined ? { resources } : {})
      })
      if (!started.ok) return errorResult(started.error)
      const { runId, outDir, remote } = started.status
      const where = remote ? ` on ${remote.host}` : ''
      return {
        content: [
          {
            type: 'text',
            text: `Started wrapper run ${runId} (${id}, profile ${started.status.profile}${where}) in the background. ${started.status.targetReason ? `${started.status.targetReason} ` : ''}Output directory${remote ? ` (on ${remote.host})` : ''}: ${outDir}. ${
              continueWhenDone === false
                ? 'The conversation will NOT be woken when it ends.'
                : 'When it ends Phi wakes the main agent with the outcome, so you do not need to wait for it.'
            } You can check it with wrapper_status, wait for it with wrapper_wait (only if the task needs the result now), or stop it with wrapper_cancel.`
          }
        ],
        details: { kind: 'wrapper_run_started', id, runId, outDir }
      }
    }
  }
}

/** One run in detail, or the list of recent runs when no run id is given. */
export function buildWrapperCompositionStatusTool(jobs: WrapperJobClient): CustomTool {
  return {
    name: 'wrapper_status',
    label: 'Wrapper Run Status',
    description:
      'Report on a wrapper run started with wrapper_run: its state (running, completed, failed, cancelled, lost), progress, output locations, and the tail of its Nextflow log. Without run_id, lists the most recent runs so you can find one.',
    parameters: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'Run id returned by wrapper_run, e.g. "wrun_…". Omit to list recent runs.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const runId = runIdParam(params)
      if (!runId) return textResult(formatJobList(await jobs.list(10)))
      const status = await jobs.status(runId)
      if (!status) return errorResult(`Run not found: ${runId}`)
      return {
        ...textResult(formatJobStatus(status)),
        details: { kind: 'wrapper_run_status', runId, state: status.state }
      }
    }
  }
}

/** Blocks (up to a limit) until a run ends. Aborting the call stops the wait, never the run. */
export function buildWrapperCompositionWaitTool(jobs: WrapperJobClient): CustomTool {
  return {
    name: 'wrapper_wait',
    label: 'Wait For Wrapper Run',
    description: `Block until a wrapper run ends or up to timeout_seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}), then report its status. If the run is still going when the time is up you get its current status and can call this again. Use it only when the task needs the run's results before the next step; otherwise start the run and finish.`,
    parameters: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: { type: 'string', description: 'Run id returned by wrapper_run.' },
        timeout_seconds: {
          type: 'number',
          description: `How long to wait, in seconds (1–${MAX_WAIT_SECONDS}). Default ${DEFAULT_WAIT_SECONDS}.`
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      const runId = runIdParam(params)
      if (!runId) return errorResult('Missing required parameter: run_id')
      const requested =
        isRecord(params) && typeof params.timeout_seconds === 'number'
          ? params.timeout_seconds
          : DEFAULT_WAIT_SECONDS
      const seconds = Math.min(Math.max(1, Math.round(requested)), MAX_WAIT_SECONDS)

      const aborted = new Promise<'aborted'>((resolve) => {
        if (signal?.aborted) resolve('aborted')
        else signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
      const outcome = await Promise.race([jobs.wait(runId, seconds * 1000), aborted])
      const status = outcome === 'aborted' ? await jobs.status(runId) : outcome
      if (!status) return errorResult(`Run not found: ${runId}`)

      const stillRunning = status.state === 'running' || status.state === 'cancelling'
      const prefix = stillRunning
        ? `Still running${outcome === 'aborted' ? ' (stopped waiting)' : ` after ${seconds}s`}.\n`
        : ''
      return {
        ...textResult(`${prefix}${formatJobStatus(status)}`),
        details: { kind: 'wrapper_run_status', runId, state: status.state }
      }
    }
  }
}

export function buildWrapperCompositionCancelTool(jobs: WrapperJobClient): CustomTool {
  return {
    name: 'wrapper_cancel',
    label: 'Cancel Wrapper Run',
    description:
      'Stop a running wrapper run: Nextflow and everything it spawned are terminated and the run is recorded as cancelled. Only cancel when the user asked for it or the run is clearly wrong.',
    parameters: {
      type: 'object',
      required: ['run_id'],
      properties: { run_id: { type: 'string', description: 'Run id returned by wrapper_run.' } }
    },
    approval: 'write',
    async execute(_toolCallId, params) {
      const runId = runIdParam(params)
      if (!runId) return errorResult('Missing required parameter: run_id')
      const result = await jobs.cancel(runId)
      if (!result.ok) return errorResult(result.error)
      return {
        ...textResult(
          `Cancelling run ${runId}: Nextflow is being stopped. Use wrapper_wait to confirm it has ended.`
        ),
        details: { kind: 'wrapper_run_cancelled', runId }
      }
    }
  }
}

export function buildWrapperCompositionTools(jobs: WrapperJobClient): CustomTool[] {
  return [
    buildWrapperCompositionSearchTool(),
    buildWrapperCompositionInspectTool(),
    buildWrapperCompositionRunTool(jobs),
    buildWrapperCompositionStatusTool(jobs),
    buildWrapperCompositionWaitTool(jobs),
    buildWrapperCompositionCancelTool(jobs)
  ]
}
