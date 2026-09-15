import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { findWrapperCompositionEntry, listWrapperCompositionCatalog } from './discovery'
import {
  WRAPPER_EXECUTION_PROFILES,
  runWrapperComposition,
  type WrapperExecutionProfile
} from './executor'

/**
 * The generic, progressively-loaded `wrapper.*` tools described in
 * docs/design/phi-wrapper-agent-composition-design.md section 4 — search,
 * inspect, then run. Supersedes the older one-tool-per-bundled-wrapper
 * model in `../tools.ts` (`buildDefaultWrapperCustomTools`), which this
 * build's `omp-sdk-worker.ts` no longer wires in, to avoid two `wrapper.*`
 * tool sets registering the same names.
 *
 * `wrapper.run` executes directly (no separate plan/submit step) — the
 * plan-card chat UI from Milestone P1.5 was built for the older package
 * manifest and hasn't been ported to this layout yet.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDefaultParams(wrapperDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(wrapperDir, 'params.json'), 'utf-8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

export function buildWrapperCompositionSearchTool(): CustomTool {
  return {
    name: 'wrapper.search',
    label: 'Search Wrappers',
    description:
      'Search available Nextflow module/subworkflow wrappers by keyword. Returns id, name, and summary. Use before wrapper.inspect.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword to match against id, name, or summary. Omit to list everything installed.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const query =
        isRecord(params) && typeof params.query === 'string'
          ? params.query.trim().toLowerCase()
          : ''
      const results = listWrapperCompositionCatalog()
        .filter((entry) => {
          if (!query) return true
          const haystack =
            `${entry.manifest.id} ${entry.manifest.name} ${entry.manifest.summary}`.toLowerCase()
          return haystack.includes(query)
        })
        .map((entry) => ({
          id: entry.manifest.id,
          name: entry.manifest.name,
          summary: entry.manifest.summary
        }))

      return {
        content: [
          {
            type: 'text',
            text:
              results.length > 0 ? JSON.stringify(results, null, 2) : 'No matching wrappers found.'
          }
        ],
        details: { kind: 'wrapper_search_results', results }
      }
    }
  }
}

export function buildWrapperCompositionInspectTool(): CustomTool {
  return {
    name: 'wrapper.inspect',
    label: 'Inspect Wrapper',
    description:
      'Get the params/outputs contract and default run parameters for one wrapper by id (from wrapper.search), so you know what to override before calling wrapper.run.',
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
      const defaultParams = readDefaultParams(entry.wrapperDir)

      return {
        content: [
          { type: 'text', text: JSON.stringify({ ...entry.manifest, defaultParams }, null, 2) }
        ],
        details: { kind: 'wrapper_manifest', manifest: entry.manifest, defaultParams }
      }
    }
  }
}

export function buildWrapperCompositionRunTool(): CustomTool {
  return {
    name: 'wrapper.run',
    label: 'Run Wrapper',
    description:
      "Run one wrapper by id, merging the given parameter overrides into its default params.json. Executes a real local Nextflow run and returns success/failure plus a tail of the log. Choose `profile` based on what the user has available or prefers: docker (default) or singularity for container runtimes, conda to build/reuse a conda environment from the module's environment.yml instead.",
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Wrapper id, e.g. "nf-core/modules/fastqc".' },
        params: {
          type: 'object',
          description:
            'Parameter overrides merged into the wrapper default params.json, e.g. {"reads": "...", "outdir": "..."}. Only kind:input/kind:output params normally need overriding.'
        },
        profile: {
          type: 'string',
          enum: [...WRAPPER_EXECUTION_PROFILES],
          description:
            'Execution profile: "docker" (default) or "singularity" run the tool in a container; "conda" builds/reuses a conda environment instead. Ask the user which is available if unsure — do not assume Docker is installed.'
        }
      }
    },
    approval: 'write',
    async execute(_toolCallId, params) {
      const id = isRecord(params) && typeof params.id === 'string' ? params.id : undefined
      if (!id) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: id' }],
          isError: true
        }
      }
      const overrides = isRecord(params) && isRecord(params.params) ? params.params : {}
      const requestedProfile =
        isRecord(params) && typeof params.profile === 'string' ? params.profile : undefined
      if (
        requestedProfile &&
        !WRAPPER_EXECUTION_PROFILES.includes(requestedProfile as WrapperExecutionProfile)
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid profile: ${requestedProfile}. Must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}.`
            }
          ],
          isError: true
        }
      }
      const profile = (requestedProfile as WrapperExecutionProfile | undefined) ?? 'docker'
      const entry = findWrapperCompositionEntry(id)
      if (!entry) {
        return { content: [{ type: 'text', text: `Wrapper not found: ${id}` }], isError: true }
      }

      try {
        const result = await runWrapperComposition(entry.wrapperDir, overrides, profile)
        const summary = result.success
          ? `Wrapper ${id} completed successfully (profile: ${profile}).\n${result.output}`
          : `Wrapper ${id} failed (exit ${result.exitCode}, profile: ${profile}).\n${result.output}`
        return {
          content: [{ type: 'text', text: summary }],
          details: {
            kind: 'wrapper_run_result',
            id,
            success: result.success,
            exitCode: result.exitCode
          },
          ...(result.success ? {} : { isError: true })
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      }
    }
  }
}

export function buildWrapperCompositionTools(): CustomTool[] {
  return [
    buildWrapperCompositionSearchTool(),
    buildWrapperCompositionInspectTool(),
    buildWrapperCompositionRunTool()
  ]
}
