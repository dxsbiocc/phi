import { defineCopy } from '../../../lib/i18n'

/** Fixed interface copy; resource names, user input, and protocol values stay untouched. */
export const runtimeUi = defineCopy(
  {
    endpointReady: 'Endpoint ready',
    noEndpoint: 'No endpoint',
    local: 'Local',
    remote: 'Remote',
    notebookKernels: 'Notebook kernels',
    port: (port: number) => `Port ${port}`,
    sSHServer: 'SSH server',
    loginNode: 'Login node',
    loginNodeValue: (message: unknown) => `Login node · ${message}`,
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
    switchProjectToOpenNotebook: 'Switch to this project to open',
    noNotebookKernelsAreRunningInThisProject: 'No notebook kernels are running in this project.'
  },
  {
    endpointReady: '服务地址已就绪',
    noEndpoint: '无服务地址',
    local: '本地',
    remote: '远程',
    notebookKernels: 'Notebook 内核',
    port: (port: number) => `端口 ${port}`,
    sSHServer: 'SSH 服务器',
    loginNode: '登录节点',
    loginNodeValue: (message: unknown) => `登录节点 · ${message}`,
    viewStartupLog: '查看启动日志',
    refreshServerStatus: '刷新 Server 状态',
    stopJupyterServer: '停止 Jupyter server',
    startJupyterServer: '启动 Jupyter server',
    discardLocalStateServerStateIsStillUnconfirmed: '放弃本地状态（服务器侧仍未确认）',
    discardUnconfirmedLocalStateForRemoteJupyter: '放弃未确认的远程 Jupyter 本地状态',
    stopKernel: '关闭 kernel',
    stopValueKernel: (value0: unknown) => `关闭 ${value0} kernel`,
    switchProjectToOpenNotebook: '切换到此项目后打开',
    noNotebookKernelsAreRunningInThisProject: '当前项目还没有运行中的 notebook kernel。'
  }
)
