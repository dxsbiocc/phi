import { defineCopy } from '../../../lib/i18n'

/** Fixed interface copy; resource names, user input, and protocol values stay untouched. */
export const runtimeUi = defineCopy(
  {
    local: 'Local',
    remote: 'Remote',
    jupyter: 'Jupyter',
    notebooks: 'Notebook',
    portPending: 'Port pending',
    sSHServer: 'SSH server',
    viewStartupLog: 'View startup log',
    refreshJupyterAndNotebooks: 'Refresh Jupyter and Notebook status',
    stopJupyterServer: 'Stop Jupyter server',
    startJupyterServer: 'Start Jupyter server',
    discardLocalStateServerStateIsStillUnconfirmed:
      'Discard local state (server state is still unconfirmed)',
    discardUnconfirmedLocalStateForRemoteJupyter:
      'Discard unconfirmed local state for remote Jupyter',
    stopKernel: 'Stop kernel',
    stopValueKernel: (value0: unknown) => `Stop ${value0} kernel`,
    switchProjectToOpenNotebook: 'Switch to this project to open',
    noConnectedNotebooks: 'No notebooks are connected in this project.'
  },
  {
    local: '本地',
    remote: '远程',
    jupyter: 'Jupyter',
    notebooks: 'Notebook',
    portPending: '端口待分配',
    sSHServer: 'SSH 服务器',
    viewStartupLog: '查看启动日志',
    refreshJupyterAndNotebooks: '刷新 Jupyter 与 Notebook 状态',
    stopJupyterServer: '停止 Jupyter server',
    startJupyterServer: '启动 Jupyter server',
    discardLocalStateServerStateIsStillUnconfirmed: '放弃本地状态（服务器侧仍未确认）',
    discardUnconfirmedLocalStateForRemoteJupyter: '放弃未确认的远程 Jupyter 本地状态',
    stopKernel: '关闭 kernel',
    stopValueKernel: (value0: unknown) => `关闭 ${value0} kernel`,
    switchProjectToOpenNotebook: '切换到此项目后打开',
    noConnectedNotebooks: '当前项目没有已连接的 Notebook。'
  }
)
