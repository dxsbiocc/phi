import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'

import { getPhiAgentDir } from '../runtime-paths'
import {
  findWrapperCatalogEntry,
  listDefaultAgentToolWrappers,
  listWrapperCatalog,
  type WrapperCatalogEntry
} from './catalog'
import { createWrapperRunPlan } from './plans'

/**
 * Builds the LLM-callable `wrapper_*` tools — see docs/design/phi-wrapper-
 * technical-design.md, "Agent Tool Registration" and the Milestone P1.0
 * correction ("Integration With The Existing Runtime"). These are plain
 * `CustomTool` objects passed via the SDK's `customTools` option, not
 * `runtime-adapter.ts`'s approval-interception extensions — kept pure and
 * framework-adjacent-only so they're testable without a live SDK session
 * (only `execute()` touches the SDK's `CustomToolContext` shape, and even
 * that's a narrow slice: just `sessionManager.getCwd()`).
 */

const TOOL_NAME_PREFIX = 'wrapper_'

/** "phi/ngs/fastq-qc" -> "phi_ngs_fastq_qc" — a safe, unique tool name per canonical id. */
export function wrapperToolName(canonicalId: string): string {
  return `${TOOL_NAME_PREFIX}${canonicalId.replace(/[/-]/g, '_')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface WrapperSearchResultItem {
  id: string
  name: string
  version: string
  trustTier: string
  summary: string
}

function catalogSearchItem(entry: WrapperCatalogEntry): WrapperSearchResultItem {
  return {
    id: entry.manifest.id,
    name: entry.manifest.name,
    version: entry.manifest.version,
    trustTier: entry.trustTier,
    summary: entry.manifest.summary
  }
}

/**
 * `wrapper_search` — always registered. Searches the full installed
 * catalog (bundled and custom) so the agent can tell the user a custom
 * wrapper exists, even though only bundled ones become their own callable
 * tool by default (see technical design's Agent Tool Registration).
 */
export function buildWrapperSearchTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'wrapper_search',
    label: 'Search Wrappers',
    description:
      'Search installed Phi wrapper definitions (reproducible bioinformatics/heavy-CLI tools) by keyword. Returns id, name, version, trust tier, and summary. Use this before wrapper_inspect or a specific wrapper_<id> tool to find the right wrapper.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword to match against wrapper id, name, or summary. Omit to list everything installed.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const query =
        isRecord(params) && typeof params.query === 'string'
          ? params.query.trim().toLowerCase()
          : ''
      const results = listWrapperCatalog(agentDir)
        .filter((entry) => {
          if (!query) return true
          const haystack =
            `${entry.manifest.id} ${entry.manifest.name} ${entry.manifest.summary}`.toLowerCase()
          return haystack.includes(query)
        })
        .map(catalogSearchItem)

      return {
        content: [
          {
            type: 'text',
            text: results.length > 0 ? JSON.stringify(results, null, 2) : '没有找到匹配的 wrapper。'
          }
        ],
        details: { kind: 'wrapper_search_results', results }
      }
    }
  }
}

/**
 * `wrapper_inspect` — always registered. Returns manifest detail (inputs,
 * parameter schema, outputs, resourceClass, profiles) for one wrapper by
 * canonical id, so the agent can decide what params to pass before calling
 * the wrapper's own execute tool.
 */
export function buildWrapperInspectTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'wrapper_inspect',
    label: 'Inspect Wrapper',
    description:
      'Get full manifest detail for one installed wrapper by its canonical id (from wrapper_search) — inputs, parameter schema, declared outputs, resource class, and available profiles.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Canonical wrapper id, e.g. "phi/ngs/fastq-qc".' },
        version: {
          type: 'string',
          description: 'Optional exact version; defaults to the newest installed.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const id = isRecord(params) && typeof params.id === 'string' ? params.id : undefined
      if (!id) {
        return {
          content: [{ type: 'text', text: '缺少必填参数: id' }],
          isError: true
        }
      }
      const requestedVersion =
        isRecord(params) && typeof params.version === 'string' ? params.version : undefined

      const candidates = listWrapperCatalog(agentDir).filter((entry) => entry.manifest.id === id)
      const entry = requestedVersion
        ? candidates.find((candidate) => candidate.manifest.version === requestedVersion)
        : candidates.sort((a, b) => b.manifest.version.localeCompare(a.manifest.version))[0]

      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: `未找到已安装的 wrapper: ${id}${requestedVersion ? `@${requestedVersion}` : ''}`
            }
          ],
          isError: true
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(entry.manifest, null, 2) }],
        details: { kind: 'wrapper_manifest', manifest: entry.manifest, trustTier: entry.trustTier }
      }
    }
  }
}

/**
 * Builds the `wrapper_<id>` execute tool for one specific catalog entry.
 * Calling it creates a `WrapperRunPlan` (never a submitted run — submission
 * is always a separate, explicit user action through the plan card's plain
 * IPC, not something the agent can trigger — see technical design's
 * "Plan/Run UI Is Not A New Pending-Action Type"). The result's `details`
 * carries only `{ kind: 'wrapper_plan', planId }`; the renderer loads full
 * plan detail from the store by id (see chatItems.ts's
 * `extractWrapperPlanId` and WrapperPlanCard.tsx) — the tool result itself
 * never repeats large plan content back into the chat transcript.
 */
export function buildWrapperExecuteTool(
  entry: WrapperCatalogEntry,
  agentDir: string = getPhiAgentDir()
): CustomTool {
  const { manifest, trustTier } = entry

  return {
    name: wrapperToolName(manifest.id),
    label: manifest.name,
    description: `${manifest.summary} (${manifest.id}@${manifest.version}, ${trustTier}). Creates a run plan — it does not submit or execute anything. The user reviews and submits the resulting plan card themselves.`,
    parameters: manifest.parameters.schema,
    approval: 'write',
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      try {
        const cwd = ctx.sessionManager.getCwd()
        const freshEntry = findWrapperCatalogEntry(manifest.id, manifest.version, agentDir) ?? entry
        const plan = createWrapperRunPlan({
          actor: 'agent',
          wrapper: freshEntry,
          params: isRecord(params) ? params : {},
          cwd,
          agentDir
        })

        const summary = plan.validation.valid
          ? `已创建计划 ${plan.planId}（${manifest.id}），校验通过。请让用户在聊天中查看计划卡片并提交。`
          : `已创建计划 ${plan.planId}（${manifest.id}），但校验未通过：${plan.validation.errors.join('; ')}`

        return {
          content: [{ type: 'text', text: summary }],
          details: { kind: 'wrapper_plan', planId: plan.planId },
          ...(plan.validation.valid ? {} : { isError: true })
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

/**
 * Default `customTools` set for a session: always `wrapper_search` +
 * `wrapper_inspect`, plus one execute tool per `bundled` wrapper — `custom`
 * wrappers never register here (see technical design's Agent Tool
 * Registration; "top-N" is trivial with today's single-wrapper catalog but
 * this is shaped for more).
 */
export function buildDefaultWrapperCustomTools(agentDir: string = getPhiAgentDir()): CustomTool[] {
  return [
    buildWrapperSearchTool(agentDir),
    buildWrapperInspectTool(agentDir),
    ...listDefaultAgentToolWrappers(agentDir).map((entry) =>
      buildWrapperExecuteTool(entry, agentDir)
    )
  ]
}
