import { defineCopy } from '../../../lib/i18n'

/** Fixed interface copy; resource names, user input, and protocol values stay untouched. */
export const runtimeUi = defineCopy(
  {
    endpointReady: 'Endpoint ready',
    noEndpoint: 'No endpoint',
    notebookKernels: 'Notebook kernels',
    port: (port: number) => `Port ${port}`,
    sSHServer: 'SSH server',
    valueLoginNodeValue: (value0: unknown, value1: unknown) => `${value0} · Login node · ${value1}`,
    valueLoginNode: (value0: unknown) => `${value0} · Login node`,
    viewStartupLog: 'View startup log',
    refreshServerStatus: 'Refresh server status',
    stopJupyterServer: 'Stop Jupyter server',
    startJupyterServer: 'Start Jupyter server',
    discardLocalStateServerStateIsStillUnconfirmed:
      'Discard local state (server state is still unconfirmed)',
    discardUnconfirmedLocalStateForRemoteJupyter:
      'Discard unconfirmed local state for remote Jupyter',
    stopKernel: 'Stop kernel',
    stopValueKernel: (value0: unknown) => `Stop ${value0} kernel`,
    noNotebookKernelsAreRunningInThisProject: 'No notebook kernels are running in this project.'
  },
  {
    endpointReady: '服务地址已就绪',
    noEndpoint: '无服务地址',
    notebookKernels: 'Notebook 内核',
    port: (port: number) => `端口 ${port}`,
    sSHServer: 'SSH 服务器',
    valueLoginNodeValue: (value0: unknown, value1: unknown) => `${value0} · 登录节点 · ${value1}`,
    valueLoginNode: (value0: unknown) => `${value0} · 登录节点`,
    viewStartupLog: '查看启动日志',
    refreshServerStatus: '刷新 Server 状态',
    stopJupyterServer: '停止 Jupyter server',
    startJupyterServer: '启动 Jupyter server',
    discardLocalStateServerStateIsStillUnconfirmed: '放弃本地状态（服务器侧仍未确认）',
    discardUnconfirmedLocalStateForRemoteJupyter: '放弃未确认的远程 Jupyter 本地状态',
    stopKernel: '关闭 kernel',
    stopValueKernel: (value0: unknown) => `关闭 ${value0} kernel`,
    noNotebookKernelsAreRunningInThisProject: '当前项目还没有运行中的 notebook kernel。'
  }
)
