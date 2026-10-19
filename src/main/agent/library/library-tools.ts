import type { PhiTool, PhiToolContext } from '../engine/types'

import {
  auditLibrary,
  findPapers,
  listPapers,
  removePaper,
  savePaper,
  updatePaper
} from './library-store'
import type { LibraryListFilters, SavePaperInput, UpdatePaperInput } from './library-types'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'
export type LibraryToolAction = 'save' | 'update' | 'remove' | 'list' | 'find' | 'audit'
export const LIBRARY_TOOL_NAMES = Object.freeze([
  'lib.save',
  'lib.update',
  'lib.remove',
  'lib.list',
  'lib.find',
  'lib.audit'
] as const)

export interface LibraryToolStore {
  save(input: SavePaperInput): ReturnType<typeof savePaper> | Promise<ReturnType<typeof savePaper>>
  update(
    id: string,
    patch: UpdatePaperInput
  ): ReturnType<typeof updatePaper> | Promise<ReturnType<typeof updatePaper>>
  remove(id: string): ReturnType<typeof removePaper> | Promise<ReturnType<typeof removePaper>>
  list(
    filters: LibraryListFilters
  ): ReturnType<typeof listPapers> | Promise<ReturnType<typeof listPapers>>
  find(
    query: string,
    filters: LibraryListFilters
  ): ReturnType<typeof findPapers> | Promise<ReturnType<typeof findPapers>>
  audit(): ReturnType<typeof auditLibrary> | Promise<ReturnType<typeof auditLibrary>>
}
export type LibraryToolStoreFactory = (
  context: PhiToolContext,
  signal?: AbortSignal
) => LibraryToolStore

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`Missing required parameter: ${name}`)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function filtersFrom(params: Record<string, unknown>): LibraryListFilters {
  return {
    ...(typeof params.collectionId === 'string' ? { collectionId: params.collectionId } : {}),
    ...(typeof params.processingStage === 'string'
      ? { processingStage: params.processingStage as LibraryListFilters['processingStage'] }
      : {}),
    ...(typeof params.priorityTier === 'string'
      ? { priorityTier: params.priorityTier as LibraryListFilters['priorityTier'] }
      : {}),
    ...(stringArray(params.tags) ? { tags: stringArray(params.tags) } : {})
  }
}

function summarizePaperList(count: number): string {
  return count === 1 ? '找到 1 篇文献。' : `找到 ${count} 篇文献。`
}

function toolResult(
  text: string,
  details: Record<string, unknown>,
  isError = false
): {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
  isError?: true
} {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(isError ? { isError: true as const } : {})
  }
}

async function executeLibraryAction(
  action: LibraryToolAction,
  store: LibraryToolStore,
  params: Record<string, unknown>
): Promise<{ summary: string; details: Record<string, unknown> }> {
  switch (action) {
    case 'save': {
      const result = await store.save(params as SavePaperInput)
      return {
        summary:
          result.action === 'created'
            ? `已保存文献：${result.paper.title}`
            : `已更新已有文献：${result.paper.title}`,
        details: { kind: 'library_save_result', ...result }
      }
    }
    case 'update': {
      const id = stringValue(params.id, 'id')
      const paper = await store.update(id, params as UpdatePaperInput)
      return {
        summary: `已更新文献：${paper.title}`,
        details: { kind: 'library_paper', paper }
      }
    }
    case 'remove': {
      const id = stringValue(params.id, 'id')
      const result = await store.remove(id)
      return {
        summary: result.removed ? `已移除文献：${result.paper?.title}` : `未找到文献：${id}`,
        details: { kind: 'library_remove_result', ...result }
      }
    }
    case 'list': {
      const papers = await store.list(filtersFrom(params))
      return {
        summary: summarizePaperList(papers.length),
        details: { kind: 'library_paper_list', papers }
      }
    }
    case 'find': {
      const query = typeof params.query === 'string' ? params.query : ''
      const papers = await store.find(query, filtersFrom(params))
      return {
        summary: summarizePaperList(papers.length),
        details: { kind: 'library_paper_list', query, papers }
      }
    }
    case 'audit': {
      const report = await store.audit()
      return {
        summary:
          report.issueCount === 0
            ? `文献库审计通过，检查 ${report.paperCount} 篇文献。`
            : `文献库审计发现 ${report.issueCount} 个问题。`,
        details: { kind: 'library_audit_report', report }
      }
    }
    default:
      return assertNever(action)
  }
}

function buildLibraryTool(
  action: LibraryToolAction,
  definition: Omit<PhiTool, 'execute' | 'site'>,
  storeFactory: LibraryToolStoreFactory
): PhiTool {
  return {
    ...definition,
    site: 'host',
    async execute(_toolCallId, params, _onUpdate, ctx: PhiToolContext, signal) {
      try {
        const result = await executeLibraryAction(
          action,
          storeFactory(ctx, signal),
          recordValue(params)
        )
        return toolResult(result.summary, result.details)
      } catch (error) {
        return toolResult(errorMessage(error), {}, true)
      }
    }
  }
}

export function buildLibraryCustomTools(
  storeFactory: LibraryToolStoreFactory = localLibraryStore
): PhiTool[] {
  const tool = (
    action: LibraryToolAction,
    definition: Omit<PhiTool, 'execute' | 'site'>
  ): PhiTool => buildLibraryTool(action, definition, storeFactory)
  const paperProperties = {
    source: { type: 'string', description: 'Literature source, e.g. pubmed, europepmc, arxiv.' },
    sourceId: { type: 'string', description: 'Source-specific paper id.' },
    id: {
      type: 'string',
      description: 'Alias for sourceId when saving or target id when updating.'
    },
    title: { type: 'string', description: 'Paper title.' },
    authors: { type: 'array', items: { type: 'string' }, description: 'Author names.' },
    abstract: { type: 'string', description: 'Abstract text, if available.' },
    doi: { type: 'string', description: 'DOI, if available.' },
    priorityTier: { type: 'string', enum: ['must', 'weekly', 'radar', 'drop'] },
    processingStage: {
      type: 'string',
      enum: ['discovered', 'skimmed', 'deep_read', 'synthesized']
    },
    tags: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    collectionId: { type: 'string' },
    fullTextStatus: { type: 'string', enum: ['available', 'unavailable', 'not_attempted'] }
  }

  const filterProperties = {
    collectionId: { type: 'string' },
    processingStage: {
      type: 'string',
      enum: ['discovered', 'skimmed', 'deep_read', 'synthesized']
    },
    priorityTier: { type: 'string', enum: ['must', 'weekly', 'radar', 'drop'] },
    tags: { type: 'array', items: { type: 'string' } }
  }

  return [
    tool('save', {
      name: LIBRARY_TOOL_NAMES[0],
      label: 'Save Paper',
      description:
        'Save or exact-deduplicate one paper into the current project literature library. This writes only the local project library, not external sources.',
      parameters: {
        type: 'object',
        required: ['title'],
        properties: paperProperties
      },
      approval: 'write'
    }),
    tool('update', {
      name: LIBRARY_TOOL_NAMES[1],
      label: 'Update Paper',
      description:
        'Update local notes, tags, collection, priority, processing stage, xrefs, or full-text status for a saved paper.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'canonicalId, alias, DOI, or source id.' },
          priorityTier: paperProperties.priorityTier,
          processingStage: paperProperties.processingStage,
          tags: paperProperties.tags,
          notes: paperProperties.notes,
          collectionId: paperProperties.collectionId,
          fullTextStatus: paperProperties.fullTextStatus
        }
      },
      approval: 'write'
    }),
    tool('remove', {
      name: LIBRARY_TOOL_NAMES[2],
      label: 'Remove Paper',
      description: 'Remove one paper from the current project literature library.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'canonicalId, alias, DOI, or source id.' }
        }
      },
      approval: 'write'
    }),
    tool('list', {
      name: LIBRARY_TOOL_NAMES[3],
      label: 'List Library Papers',
      description:
        'List saved papers from the current project literature library. Does not query external sources.',
      parameters: {
        type: 'object',
        properties: filterProperties
      },
      approval: 'read'
    }),
    tool('find', {
      name: LIBRARY_TOOL_NAMES[4],
      label: 'Find Library Papers',
      description:
        'Search saved papers in the current project literature library by title, author, DOI, tag, note, abstract, or identifier. Does not query external sources.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Local library search text.' },
          ...filterProperties
        }
      },
      approval: 'read'
    }),
    tool('audit', {
      name: LIBRARY_TOOL_NAMES[5],
      label: 'Audit Literature Library',
      description:
        'Check the current project literature library for duplicate ids, missing required fields, and orphan xrefs.',
      parameters: {
        type: 'object',
        properties: {}
      },
      approval: 'read'
    })
  ]
}

function assertNever(value: never): never {
  throw new Error(`Unexpected library tool action: ${value}`)
}

function localLibraryStore(context: PhiToolContext): LibraryToolStore {
  const cwd = context.cwd
  return {
    save: (input) => savePaper(cwd, input),
    update: (id, patch) => updatePaper(cwd, id, patch),
    remove: (id) => removePaper(cwd, id),
    list: (filters) => listPapers(cwd, filters),
    find: (query, filters) => findPapers(cwd, query, filters),
    audit: () => auditLibrary(cwd)
  }
}
