/**
 * Stable engine-owned tool names that package manifests may require.
 * Dynamic MCP, plugin, and skill script tools are deliberately excluded.
 */
export const CORE_TOOL_NAMES = [
  'agent_status',
  'agent_steer',
  'agent_stop',
  'agent_wait',
  'bash',
  'download_file',
  'edit',
  'env_request',
  'glob',
  'grep',
  'present_files',
  'read',
  'render_blocks',
  'skill_run',
  'wrapper_cancel',
  'wrapper_inspect',
  'wrapper_run',
  'wrapper_search',
  'wrapper_status',
  'wrapper_wait',
  'write'
] as const

export const CORE_TOOLS = new Set<string>(CORE_TOOL_NAMES)
