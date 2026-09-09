export type ToolActionKind = 'command' | 'python' | 'read' | 'edit' | 'search' | 'web' | 'generic'

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'apply_patch', 'patch', 'replace'])
const READ_TOOL_NAMES = new Set(['read', 'open', 'view'])
const COMMAND_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'powershell',
  'terminal',
  'exec',
  'exec_command',
  'command'
])
const SEARCH_TOOL_NAMES = new Set(['search', 'web_search', 'file_search', 'grep', 'rg'])
const WEB_TOOL_NAMES = new Set(['browser', 'open_url', 'fetch', 'web_fetch'])
const PYTHON_TOOL_NAMES = new Set(['eval'])

function normalizedToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^functions\./, '')
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function toolActionKind(toolName: string, argsPreview = '', argsJson = ''): ToolActionKind {
  const name = normalizedToolName(toolName)
  const preview = argsPreview.trim().toLowerCase()
  const args = argsJson.trim().toLowerCase()
  const isCommandTool =
    COMMAND_TOOL_NAMES.has(name) || name.includes('shell') || name.includes('command')

  if (PYTHON_TOOL_NAMES.has(name)) {
    return 'python'
  }
  if (EDIT_TOOL_NAMES.has(name) || name.includes('edit') || name.includes('write')) {
    return 'edit'
  }
  if (
    SEARCH_TOOL_NAMES.has(name) ||
    name.includes('search') ||
    (!isCommandTool &&
      (preview.startsWith('web_search') ||
        preview.startsWith('rg ') ||
        preview.startsWith('grep ')))
  ) {
    return 'search'
  }
  if (
    (!isCommandTool &&
      (looksLikeUrl(argsPreview) ||
        args.includes('"url"') ||
        args.includes('http://') ||
        args.includes('https://'))) ||
    WEB_TOOL_NAMES.has(name) ||
    name.includes('browser')
  ) {
    return 'web'
  }
  if (READ_TOOL_NAMES.has(name) || name.includes('read')) {
    return 'read'
  }
  if (isCommandTool || args.includes('"cmd"') || args.includes('"command"')) {
    return 'command'
  }
  if (
    preview.startsWith('web_search') ||
    preview.startsWith('rg ') ||
    preview.startsWith('grep ')
  ) {
    return 'search'
  }
  return 'generic'
}
