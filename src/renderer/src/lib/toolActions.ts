export type ToolActionKind =
  'command' | 'python' | 'read' | 'edit' | 'search' | 'web' | 'notebook' | 'generic'

const EDIT_TOOL_NAMES = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'replace',
  'office_apply',
  'office_deliver'
])
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

  if (name.startsWith('notebook.')) {
    return 'notebook'
  }
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

export function toolApprovalLabel(toolName: string, summary: string): string | undefined {
  const name = normalizedToolName(toolName)
  if (name === 'office_deliver') return '交付 Office 文件'
  if (name !== 'office_apply') return undefined
  if (summary.startsWith('新增幻灯片')) return '新增 PowerPoint 幻灯片'
  if (summary.startsWith('修改第') && summary.includes('页')) return '修改 PowerPoint 文本'
  if (summary.startsWith('新增段落')) return '新增 Word 段落'
  if (summary.startsWith('修改第') && summary.includes('段')) return '修改 Word 段落'
  return '修改 Office 文档'
}
