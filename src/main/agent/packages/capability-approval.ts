import type { CapabilityApprovalRequest } from './capability-service'

const labels = { wrapper: 'Wrapper', mcp: 'Connector', skill: '技能', plugin: '插件' }

export function capabilityApprovalSummary(request: CapabilityApprovalRequest): string {
  return [
    `${request.action === 'enable' ? '启用' : '安装'}${labels[request.root.type]}：${request.root.id} @ ${request.root.version}`,
    `用途：${request.reason}`,
    `来源：${request.source}（${request.trust === 'official' ? '官方签名软件源' : '已配置的软件源'}）`,
    '包含的模块与依赖：',
    ...request.packages.map(
      (item) =>
        `• ${labels[item.type]} ${item.title} (${item.id} @ ${item.version}) — ${item.source}${item.alreadyInstalled ? '，已安装' : ''}`
    ),
    `预计下载：${(request.totalSize / 1024 / 1024).toFixed(2)} MB`,
    ...(request.environments.length ? [`所需环境：${request.environments.join('、')}`] : [])
  ].join('\n')
}
