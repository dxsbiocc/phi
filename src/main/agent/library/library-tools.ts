import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'

import {
  auditLibrary,
  findPapers,
  listPapers,
  removePaper,
  savePaper,
  updatePaper
} from './library-store'
import type { LibraryListFilters, SavePaperInput, UpdatePaperInput } from './library-types'

export type LibraryToolAction = 'save' | 'update' | 'remove' | 'list' | 'find' | 'audit'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function executeLibraryAction(
  action: LibraryToolAction,
  cwd: string,
  params: Record<string, unknown>
): { summary: string; details: Record<string, unknown> } {
  switch (action) {
    case 'save': {
      const result = savePaper(cwd, params as SavePaperInput)
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
      const paper = updatePaper(cwd, id, params as UpdatePaperInput)
      return {
        summary: `已更新文献：${paper.title}`,
        details: { kind: 'library_paper', paper }
      }
    }
    case 'remove': {
      const id = stringValue(params.id, 'id')
      const result = removePaper(cwd, id)
      return {
        summary: result.removed ? `已移除文献：${result.paper?.title}` : `未找到文献：${id}`,
        details: { kind: 'library_remove_result', ...result }
      }
    }
    case 'list': {
      const papers = listPapers(cwd, filtersFrom(params))
      return {
        summary: summarizePaperList(papers.length),
        details: { kind: 'library_paper_list', papers }
      }
    }
    case 'find': {
      const query = typeof params.query === 'string' ? params.query : ''
      const papers = findPapers(cwd, query, filtersFrom(params))
      return {
        summary: summarizePaperList(papers.length),
        details: { kind: 'library_paper_list', query, papers }
      }
    }
    case 'audit': {
      const report = auditLibrary(cwd)
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
  definition: Omit<CustomTool, 'execute'>
): CustomTool {
  return {
    ...definition,
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      try {
        const result = executeLibraryAction(
          action,
          ctx.sessionManager.getCwd(),
          recordValue(params)
        )
        return toolResult(result.summary, result.details)
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), {}, true)
      }
    }
  }
}

export function buildLibraryCustomTools(): CustomTool[] {
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
    buildLibraryTool('save', {
      name: 'lib.save',
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
    buildLibraryTool('update', {
      name: 'lib.update',
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
    buildLibraryTool('remove', {
      name: 'lib.remove',
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
    buildLibraryTool('list', {
      name: 'lib.list',
      label: 'List Library Papers',
      description:
        'List saved papers from the current project literature library. Does not query external sources.',
      parameters: {
        type: 'object',
        properties: filterProperties
      },
      approval: 'read'
    }),
    buildLibraryTool('find', {
      name: 'lib.find',
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
    buildLibraryTool('audit', {
      name: 'lib.audit',
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
