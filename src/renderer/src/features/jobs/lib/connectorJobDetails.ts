import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { connectorJobDuration, connectorJobStatusLabel } from './backgroundJobs'

function startedAtLabel(setup: McpConnectorSetupProgress): string {
  if (!setup.startedAt || !Number.isFinite(Date.parse(setup.startedAt))) return '未知'
  return new Date(setup.startedAt).toLocaleString('zh-CN', { hour12: false })
}

export function connectorJobToolsLabel(setup: McpConnectorSetupProgress): string {
  return setup.toolNames?.length ? setup.toolNames.join('、') : '没有发现工具'
}

export function buildConnectorJobDetailText(
  setup: McpConnectorSetupProgress,
  nowMs: number
): string {
  return [
    `连接器名称：${setup.title ?? setup.id}`,
    `状态：${connectorJobStatusLabel(setup)}`,
    `命令：\n${setup.summary ?? setup.id}`,
    `开始时间：${startedAtLabel(setup)}`,
    `耗时：${connectorJobDuration(setup, nowMs)}`,
    `错误：\n${setup.error ?? '没有错误'}`,
    `进程输出：\n${setup.detail ?? '没有进程输出'}`,
    `工具列表：${setup.phase === 'ready' ? connectorJobToolsLabel(setup) : '不适用'}`
  ].join('\n')
}

export { startedAtLabel as connectorJobStartedAtLabel }
