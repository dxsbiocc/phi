import { parseHtmlTable } from './notebookHtmlTable'
import { type SyntaxLanguage } from '../../../lib/syntaxHighlight'
import {
  updateNotebookMetadata,
  type JsonObject,
  type NotebookDocument,
  type NotebookOutput
} from '../../../../../shared/notebookDocument'
import type {
  AnalysisKernelDiagnostics,
  AnalysisKernelLanguage,
  AnalysisKernelSummary,
  AnalysisNotebookContextReference,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  AnalysisNotebookSessionStatus,
  AnalysisNotebookSummary,
  JupyterServerStatus
} from '../../../types'

export type CellState = 'idle' | 'running' | 'error' | 'stale'

export type CanvasCell = {
  id: string
  count: number | null
  type: 'markdown' | 'code' | 'raw'
  language?: SyntaxLanguage
  state: CellState
  source: string
  executionDurationMs?: number
  outputs: NotebookOutput[]
}

export type NotebookOutlineItem = {
  id: string
  cellId: string
  level: number
  title: string
}

export type NotebookArtifact = {
  id: string
  source: string
  name: string
  kind: string
  size: string
}

export type NotebookListEntry = {
  id: string
  path: string
  name: string
  status: string
  absolutePath?: string
}

export type NotebookCellAccent = 'markdown' | 'python' | 'r' | 'code' | 'ai'

export function notebookContextKindLabel(kind: AnalysisNotebookContextReference['kind']): string {
  if (kind === 'dataframe') return 'Dataframe'
  if (kind === 'data_source') return 'Data Source'
  if (kind === 'cell_output') return 'Cell Output'
  return 'Variable'
}

export function contextReferenceForFilePath(path: string): AnalysisNotebookContextReference {
  const name = path.split(/[/\\]/).pop() || path
  return {
    id: `data_source:${path}`,
    kind: 'data_source',
    name,
    detail: path,
    preview: { source: path }
  }
}

export function truncateContextPreview(value: string, maxLength = 360): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

export function previewTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => previewTextValue(item)).join('')
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function stripHtmlPreview(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function notebookOutputPreview(
  outputs: NotebookOutput[],
  maxLength = 360
): string | undefined {
  const chunks: string[] = []

  for (const output of outputs) {
    if (output.text) {
      chunks.push(output.text)
    }

    if (output.ename || output.evalue) {
      chunks.push([output.ename, output.evalue].filter(Boolean).join(': '))
    } else if (output.traceback?.length) {
      chunks.push(output.traceback.join('\n'))
    }

    const data = output.data
    const preferredMime = ['text/markdown', 'text/plain', 'text/html'].find(
      (key) => data[key] !== undefined
    )

    if (preferredMime) {
      const raw = previewTextValue(data[preferredMime])
      const text = preferredMime === 'text/html' ? stripHtmlPreview(raw) : raw
      if (text) chunks.push(text)
    } else {
      const mime = Object.keys(data)[0]
      if (mime) chunks.push(`[${notebookOutputDataKind(mime)} output]`)
    }
  }

  const preview = truncateContextPreview(chunks.filter(Boolean).join('\n\n'), maxLength)
  return preview || undefined
}

export function notebookOutputTextChunks(outputs: NotebookOutput[]): string[] {
  const chunks: string[] = []
  for (const output of outputs) {
    if (output.text) chunks.push(output.text)
    if (output.traceback?.length) chunks.push(output.traceback.join('\n'))
    for (const value of Object.values(output.data)) {
      const text = previewTextValue(value)
      if (text) chunks.push(text)
    }
  }
  return chunks
}

export function dataframeShapeFromOutputs(outputs: NotebookOutput[]): string | undefined {
  for (const text of notebookOutputTextChunks(outputs)) {
    const explicitShape = text.match(/shape:\s*\((\d+)\s*,\s*(\d+)\)/i)
    if (explicitShape) return `${explicitShape[1]} rows, ${explicitShape[2]} columns`

    const pandasSummary = text.match(/\[(\d+)\s+rows?\s+x\s+(\d+)\s+columns?\]/i)
    if (pandasSummary) return `${pandasSummary[1]} rows, ${pandasSummary[2]} columns`
  }
  return undefined
}

export function dataframeColumnTypeLabel(type: string): string {
  if (type === 'float64' || type === 'int64') return 'number'
  if (type === 'bool') return 'boolean'
  if (type === 'object') return 'string'
  return type
}

export function dataframeColumnsFromOutputs(
  outputs: NotebookOutput[]
): Array<{ name: string; type?: string }> | undefined {
  for (const output of outputs) {
    const html = output.data['text/html']
    const htmlText = previewTextValue(html)
    if (!htmlText) continue

    const table = parseHtmlTable(htmlText)
    if (!table) continue

    return table.headers.map((name, index) => ({
      name,
      type: dataframeColumnTypeLabel(table.columnTypes[index] ?? 'object')
    }))
  }
  return undefined
}

export function sourceMentionsVariable(source: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source)
}

export function dataframePreviewFromCells(
  name: string,
  cells: CanvasCell[],
  startIndex: number
): Pick<NonNullable<AnalysisNotebookContextReference['preview']>, 'shape' | 'columns'> {
  for (const cell of cells.slice(startIndex)) {
    if (
      cell.type !== 'code' ||
      cell.outputs.length === 0 ||
      !sourceMentionsVariable(cell.source, name)
    ) {
      continue
    }

    const shape = dataframeShapeFromOutputs(cell.outputs)
    const columns = dataframeColumnsFromOutputs(cell.outputs)
    if (shape || columns?.length) {
      return { shape, columns }
    }
  }
  return {}
}

export function importContextPreviewValue(match: RegExpMatchArray): string | undefined {
  const importedModule = match[1] ?? match[3]
  const importedName = match[4]
  if (!importedModule) return undefined
  return importedName ? `${importedModule}.${importedName}` : importedModule
}

function pushNotebookContextReference(
  references: AnalysisNotebookContextReference[],
  seen: Set<string>,
  reference: AnalysisNotebookContextReference
): void {
  if (seen.has(reference.id)) return
  seen.add(reference.id)
  references.push(reference)
}

export function buildNotebookAiContextOptions(
  cells: CanvasCell[]
): AnalysisNotebookContextReference[] {
  const references: AnalysisNotebookContextReference[] = []
  const seen = new Set<string>()
  const dataframeNames = new Set<string>()
  const dataframeSourcePaths = new Set<string>()
  const assignmentPattern =
    /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n#]*(?:read_csv|read_json|read_excel|read_parquet|DataFrame|scanpy\.read|sc\.read|anndata\.read)[^\n#]*)/g
  const importPattern =
    /(?:^|\n)\s*(?:import\s+([A-Za-z_][A-Za-z0-9_.]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)|from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*))/g
  const simpleAssignmentPattern = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n#]+)/g
  const dataPathPattern = /['"]([^'"]+\.(?:csv|tsv|json|jsonl|xlsx|xls|parquet|h5ad|loom))['"]/gi

  for (const cell of cells) {
    if (cell.type !== 'code') continue

    for (const match of cell.source.matchAll(assignmentPattern)) {
      const name = match[1]
      const expression = match[2]?.trim() ?? ''
      if (name) dataframeNames.add(name)
      for (const pathMatch of expression.matchAll(dataPathPattern)) {
        dataframeSourcePaths.add(pathMatch[1])
      }
    }
  }

  cells.forEach((cell, index) => {
    if (cell.type === 'code') {
      for (const match of cell.source.matchAll(assignmentPattern)) {
        const name = match[1]
        const expression = match[2]?.trim()
        const dataframePreview = dataframePreviewFromCells(name, cells, index)
        pushNotebookContextReference(references, seen, {
          id: `dataframe:${name}`,
          kind: 'dataframe',
          name,
          detail: expression ? expression.slice(0, 80) : 'in-memory',
          cellId: cell.id,
          preview: {
            source: expression ? truncateContextPreview(expression, 180) : 'in-memory',
            ...dataframePreview
          }
        })
      }

      for (const match of cell.source.matchAll(importPattern)) {
        const name = match[2] ?? match[4]
        if (!name) continue
        pushNotebookContextReference(references, seen, {
          id: `variable:${name}`,
          kind: 'variable',
          name,
          detail: 'module',
          cellId: cell.id,
          preview: {
            value: importContextPreviewValue(match)
          }
        })
      }

      for (const match of cell.source.matchAll(simpleAssignmentPattern)) {
        const name = match[1]
        const expression = match[2]?.trim()
        if (!name) continue
        if (dataframeNames.has(name)) continue
        pushNotebookContextReference(references, seen, {
          id: `variable:${name}`,
          kind: 'variable',
          name,
          detail: 'in-memory',
          cellId: cell.id,
          preview: expression
            ? {
                value: truncateContextPreview(expression, 180)
              }
            : undefined
        })
      }

      for (const match of cell.source.matchAll(dataPathPattern)) {
        const name = match[1]
        if (dataframeSourcePaths.has(name)) continue
        pushNotebookContextReference(references, seen, {
          id: `data_source:${name}`,
          kind: 'data_source',
          name,
          detail: 'file path',
          cellId: cell.id,
          preview: {
            source: name
          }
        })
      }
    }

    if (cell.outputs.length > 0) {
      const output = notebookOutputPreview(cell.outputs)
      pushNotebookContextReference(references, seen, {
        id: `cell_output:${cell.id}`,
        kind: 'cell_output',
        name: `cell-${index + 1}`,
        detail: output
          ? 'output preview'
          : `${cell.outputs.length} output${cell.outputs.length === 1 ? '' : 's'}`,
        cellId: cell.id,
        preview: {
          code: truncateContextPreview(cell.source, 420),
          output
        }
      })
    }
  })

  return references
}

export function notebookCellAccent(cell: CanvasCell): NotebookCellAccent {
  if (cell.type === 'markdown') return 'markdown'
  if (cell.language === 'python') return 'python'
  if (cell.language === 'r') return 'r'
  return 'code'
}

export function compactPath(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : `${parts[0]}/.../${parts[parts.length - 1]}`
}

export function stringFromMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' ? value : undefined
}

export function objectFromMetadata(metadata: JsonObject, key: string): JsonObject | undefined {
  const value = metadata[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

export function notebookLanguage(document: NotebookDocument): string {
  const languageInfo = objectFromMetadata(document.metadata, 'language_info')
  const kernelSpec = objectFromMetadata(document.metadata, 'kernelspec')
  return (
    stringFromMetadata(languageInfo ?? {}, 'name') ??
    stringFromMetadata(kernelSpec ?? {}, 'language') ??
    stringFromMetadata(kernelSpec ?? {}, 'display_name') ??
    'Code'
  )
}

export function notebookKernelLanguage(document: NotebookDocument): AnalysisKernelLanguage | null {
  const language = notebookLanguage(document).toLocaleLowerCase()
  if (language === 'python' || language.startsWith('python')) return 'python'
  if (language === 'r' || language === 'ir') return 'r'
  return null
}

export function notebookKernelName(document: NotebookDocument): string {
  const kernelSpec = objectFromMetadata(document.metadata, 'kernelspec')
  return stringFromMetadata(kernelSpec ?? {}, 'name') ?? ''
}

export function withNotebookKernel(
  document: NotebookDocument,
  kernel: AnalysisKernelSummary
): NotebookDocument {
  const currentLanguageInfo = objectFromMetadata(document.metadata, 'language_info') ?? {}
  return updateNotebookMetadata(document, {
    ...document.metadata,
    kernelspec: {
      name: kernel.name,
      display_name: kernel.displayName,
      language: kernel.rawLanguage
    },
    language_info: {
      ...currentLanguageInfo,
      name: kernel.rawLanguage
    }
  })
}

export function notebookSyntaxLanguage(document: NotebookDocument): SyntaxLanguage {
  const language = notebookLanguage(document).toLocaleLowerCase()
  if (language === 'python' || language.startsWith('python')) return 'python'
  if (language === 'r' || language === 'ir') return 'r'
  if (language === 'javascript' || language === 'js' || language === 'node') return 'javascript'
  if (language === 'typescript' || language === 'ts') return 'typescript'
  if (language === 'shell' || language === 'bash' || language === 'zsh') return 'shell'
  return 'plain'
}

export function kernelAvailabilityLabel(
  document: NotebookDocument | null,
  diagnostics: AnalysisKernelDiagnostics | null | undefined,
  isLoading: boolean,
  error: string | null | undefined
): string {
  if (isLoading) return 'Checking kernels'
  if (error) return 'Kernel check failed'
  if (!diagnostics) return document ? 'Kernel unchecked' : 'Kernel preview'
  if (!diagnostics.jupyterServer.available) return 'Jupyter missing'
  if (!document) return 'Jupyter ready'

  const language = notebookKernelLanguage(document)
  if (language === 'python' && !diagnostics.hasPythonKernel) return 'Python kernel missing'
  if (language === 'r' && !diagnostics.hasRKernel) return 'R kernel missing'

  const matchingKernel =
    diagnostics.kernels.find((kernel) => kernel.name === notebookKernelName(document)) ??
    diagnostics.kernels.find((kernel) => kernel.language === language) ??
    diagnostics.kernels.find((kernel) => kernel.name === diagnostics.preferredKernelName)
  return matchingKernel ? `${matchingKernel.displayName} · not started` : 'Kernel missing'
}

export function kernelAvailabilityColor(
  label: string
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (label.includes('failed')) return 'error'
  if (label.includes('missing')) return 'warning'
  if (label.includes('not started')) return 'primary'
  if (label.includes('ready')) return 'success'
  return 'default'
}

export function jupyterServerStateLabel(status: JupyterServerStatus | null | undefined): string {
  if (!status) return 'Jupyter server unchecked'
  if (status.state === 'starting') return 'Jupyter server starting'
  if (status.state === 'ready') return 'Jupyter server ready'
  if (status.state === 'error') return 'Jupyter server error'
  if (status.state === 'exited') return 'Jupyter server exited'
  return 'Jupyter server stopped'
}

export function jupyterServerStateColor(
  status: JupyterServerStatus | null | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (!status) return 'default'
  if (status.state === 'ready') return 'success'
  if (status.state === 'starting') return 'primary'
  if (status.state === 'error') return 'error'
  if (status.state === 'exited') return 'warning'
  return 'default'
}

export function notebookSessionStateLabel(
  status: AnalysisNotebookSessionStatus | null | undefined
): string {
  if (!status) return 'Kernel disconnected'
  if (status.state === 'missing') return 'Kernel missing'
  if (status.state === 'idle') return 'Kernel idle'
  if (status.state === 'busy') return 'Kernel busy'
  if (status.state === 'restarting') return 'Kernel restarting'
  if (status.state === 'disconnected') return 'Kernel disconnected'
  if (status.state === 'error') return 'Kernel error'
  return 'Kernel unknown'
}

export function notebookSessionStateColor(
  status: AnalysisNotebookSessionStatus | null | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (!status) return 'default'
  if (status.state === 'idle') return 'success'
  if (status.state === 'busy' || status.state === 'restarting') return 'primary'
  if (status.state === 'missing' || status.state === 'disconnected') return 'warning'
  if (status.state === 'error') return 'error'
  return 'default'
}

export function notebookOutputDataKind(key: string): string {
  if (key === 'text/html') return 'HTML'
  if (key === 'image/png') return 'PNG'
  if (key === 'image/jpeg') return 'JPEG'
  if (key === 'image/svg+xml') return 'SVG'
  if (key === 'application/vnd.plotly.v1+json') return 'Plotly'
  if (key === 'application/javascript' || key === 'text/javascript') return 'JavaScript'
  if (key === 'application/json') return 'JSON'
  if (key.startsWith('text/')) return key.slice('text/'.length).toUpperCase()
  return key
}

export function notebookOutputDataBytes(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

export function kernelOptionLabel(kernel: AnalysisKernelSummary): string {
  return kernel.name === kernel.displayName
    ? kernel.displayName
    : `${kernel.displayName} (${kernel.name})`
}

export function notebookArtifacts(
  document: NotebookDocument | null | undefined
): NotebookArtifact[] {
  if (!document) return []
  return document.cells.flatMap((cell, cellIndex) => {
    if (cell.cellType !== 'code') return []
    return cell.outputs.flatMap((output, outputIndex) => {
      const entries = Object.entries(output.data).filter(
        ([key]) => key !== 'text/plain' && key !== 'text/markdown'
      )
      return entries.map(([key, value], dataIndex) => {
        const kind = notebookOutputDataKind(key)
        return {
          id: `${cell.id}:${outputIndex}:${key}`,
          source:
            cell.executionCount !== null ? `Cell ${cell.executionCount}` : `Cell ${cellIndex + 1}`,
          name: `${cell.id || `cell-${cellIndex + 1}`}.${kind.toLocaleLowerCase()}`,
          kind,
          size: formatBytes(notebookOutputDataBytes(value) + dataIndex)
        }
      })
    })
  })
}

export function documentCells(
  document: NotebookDocument,
  executingCellId?: string | null
): CanvasCell[] {
  const language = notebookSyntaxLanguage(document)
  return document.cells.map((cell) => ({
    id: cell.id,
    count: cell.executionCount,
    type: cell.cellType,
    language: cell.cellType === 'code' ? language : undefined,
    state:
      executingCellId === cell.id
        ? 'running'
        : cell.outputs.some((output) => output.outputType === 'error')
          ? 'error'
          : 'idle',
    source: cell.source,
    executionDurationMs: cellExecutionDurationMs(cell.metadata),
    outputs: cell.cellType === 'code' ? cell.outputs : []
  }))
}

export function markdownHeadingTitle(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim())
  if (!match) return null
  const title = match[2].trim()
  if (!title) return null
  return { level: match[1].length, title }
}

export function plainMarkdownInlineText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

export function notebookOutline(cells: CanvasCell[]): NotebookOutlineItem[] {
  return cells.flatMap((cell) => {
    if (cell.type !== 'markdown') return []
    return cell.source
      .split(/\r?\n/)
      .map((line, lineIndex) => {
        const heading = markdownHeadingTitle(line)
        if (!heading) return null
        return {
          id: `${cell.id}:heading-${lineIndex}`,
          cellId: cell.id,
          level: heading.level,
          title: heading.title
        }
      })
      .filter((item): item is NotebookOutlineItem => Boolean(item))
  })
}

export function cellExecutionDurationMs(metadata: JsonObject): number | undefined {
  const phi = objectFromMetadata(metadata, 'phi')
  const duration = phi?.executionDurationMs
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined
}

export function formatExecutionDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.round(durationMs / 1000)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function notebookStatus(notebook: AnalysisNotebookSummary): string {
  return `${formatBytes(notebook.bytes)} · ${new Date(notebook.modifiedAt).toLocaleDateString()}`
}

export function registryNotebooks(
  registry: AnalysisNotebookRegistry | null | undefined
): NotebookListEntry[] {
  if (!registry) return []
  return registry.notebooks.map((notebook) => ({
    id: notebook.path,
    path: notebook.relativePath,
    name: notebook.name,
    absolutePath: notebook.path,
    status: notebookStatus(notebook)
  }))
}

export function notebookFileEntry(
  file: AnalysisNotebookFile | null | undefined
): NotebookListEntry | null {
  if (!file) return null
  return {
    id: file.path,
    path: file.relativePath,
    name: file.name,
    absolutePath: file.path,
    status: `${formatBytes(file.bytes)} · ${new Date(file.modifiedAt).toLocaleDateString()}`
  }
}

export function notebookTabLabel(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
