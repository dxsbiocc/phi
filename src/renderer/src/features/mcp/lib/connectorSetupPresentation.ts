import type {
  FeaturedMcpConnector,
  McpConnectorSetupPhase,
  McpConnectorSetupProgress
} from '../../../../../shared/mcpConnectorCatalog'

export function connectorSetupActive(setup?: McpConnectorSetupProgress): boolean {
  return Boolean(
    setup && ['downloading', 'installing', 'environment', 'starting'].includes(setup.phase)
  )
}

export function connectorSetupLabel(phase: McpConnectorSetupPhase): string {
  return {
    downloading: '正在获取连接器文件',
    installing: '正在安装连接器',
    environment: '正在准备运行环境',
    starting: '正在启动并检查本地服务',
    ready: '连接已验证',
    installed: '已安装',
    removed: '未安装',
    failed: '设置失败'
  }[phase]
}

export function localConnectorToolsPrerequisite(connector: FeaturedMcpConnector): string | null {
  if (connector.transport !== 'stdio') return null
  if (connectorSetupActive(connector.setup)) return '正在准备本地服务，完成后会读取工具。'
  if (!connector.added) return '添加连接器并准备本地服务后，可读取服务端工具。'
  if (connector.environmentState === 'not-built')
    return '准备运行环境后，可启动本地服务并读取工具。'
  return null
}
