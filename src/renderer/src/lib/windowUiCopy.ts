import { defineCopy } from './i18n'

export const windowUiCopy = defineCopy(
  {
    close: 'Close',
    minimize: 'Minimize',
    fullscreen: 'Full screen',
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    searchChats: 'Find chats',
    panels: { jobs: 'Background Jobs', terminal: 'Terminal', browser: 'Browser' },
    restorePanels: 'Restore split panels',
    expandPanel: (label: string) => `Expand ${label} in the workspace`,
    refreshJobs: 'Refresh Background Jobs',
    closePanel: (label: string) => `Close ${label}`,
    noWorkspace: 'No workspace yet',
    selectWorkspace: 'Select a project chat to view the file tree for its working folder.',
    generalWorkspace: 'General',
    unavailableServer: 'Server profile unavailable',
    connection: {
      unchecked: 'Connection not checked',
      connecting: 'Connecting',
      reachable: 'Connected',
      offline: 'Server offline',
      authentication_failed: 'Authentication failed',
      identity_failed: 'Host identity verification failed',
      permission_failed: 'Directory access denied',
      configuration_failed: 'Server configuration unavailable'
    }
  },
  {
    close: '关闭',
    minimize: '最小化',
    fullscreen: '全屏',
    collapseSidebar: '收起侧边栏',
    expandSidebar: '展开侧边栏',
    searchChats: '查找会话',
    panels: { jobs: '后台任务', terminal: '终端', browser: '浏览器' },
    restorePanels: '还原分屏',
    expandPanel: (label) => `在右侧工作区展开${label}`,
    refreshJobs: '刷新后台任务',
    closePanel: (label) => `关闭${label}`,
    noWorkspace: '还没有工作空间',
    selectWorkspace: '选择项目会话后显示当前工作路径的文件树。',
    generalWorkspace: '普通',
    unavailableServer: '服务器档案不可用',
    connection: {
      unchecked: '连接待检查',
      connecting: '连接中',
      reachable: '已连接',
      offline: '服务器离线',
      authentication_failed: '认证失败',
      identity_failed: '主机身份校验失败',
      permission_failed: '目录权限不足',
      configuration_failed: '服务器配置不可用'
    }
  }
)
