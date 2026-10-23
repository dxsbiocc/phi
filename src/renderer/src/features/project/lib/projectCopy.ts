import { defineCopy } from '../../../lib/i18n'

export const projectCopy = defineCopy(
  {
    unableToLoadServersCloseAndTryAgain: 'Unable to load servers. Close and try again.',
    unableToCreateProjectTryAgain: 'Unable to create project. Try again.',
    newProject: 'New project',
    projectName: 'Project name',
    permissionApproval: 'Permission approval',
    askBeforeImportantActions: 'Ask before important actions',
    approveForMe: 'Approve for me',
    fullAccess: 'Full access',
    askBeforeRunningCommandsWritingOrEditingFiles:
      'Ask before running commands, writing or editing files.',
    runAllowedToolsAutomaticallyWithoutAskingEachTime:
      'Run allowed tools automatically without asking each time.',
    accessFilesAndExecuteCommandsOnTheSelectedServerWith:
      'Access files and execute commands on the selected server with the current account’s permissions.',
    unrestrictedAccessToTheInternetAndAnyFileOnYour:
      'Unrestricted access to the internet and any file on your computer.',
    cancel: 'Cancel',
    create: 'Create',
    projectsRememberALocalWorkingDirectoryTemporaryConversationsDoNot:
      'Projects remember a local working directory. Temporary conversations do not need one.',
    remoteProjectsRememberADirectoryOnTheSelectedServerProject:
      'Remote projects remember a directory on the selected server. Project file and command operations run on that server.',
    localFolder: 'Local folder',
    remoteServer: 'Remote server',
    workingDirectory: 'Working directory',
    useTheButtonOnTheRightToChooseAFolder: 'Use the button on the right to choose a folder',
    chooseFolder: 'Choose folder',
    connectingToServer: 'Connecting to server',
    downloadingRemoteRuntime: (percent: number, attempt: number) =>
      `Downloading remote runtime ${percent}% · attempt ${attempt}`,
    downloadingRemoteRuntimeWithoutTotal: (attempt: number) =>
      `Downloading remote runtime · attempt ${attempt}`,
    connectionNotChecked: 'Connection not checked',
    reconnect: 'Reconnect',
    settingsRemote: 'Settings → Remote',
    historyAndDraftsRemainAvailableVerifyUncertainFileChangesOr:
      'History and drafts remain available. Verify uncertain file changes or command results on the server first.',
    projectDirectoryOnServer: 'Project directory on server',
    enterAnAbsoluteServerPathStartingWith: 'Enter an absolute server path starting with /.',
    enterAnAbsolutePathOrChooseOneInTheDirectory:
      'Enter an absolute path or choose one in the directory tree below.',
    filterFolders: 'Filter folders…',
    sSHServer: 'SSH server',
    loadingServers: 'Loading servers…',
    chooseAHostFromSshConfig: 'Choose a host from ~/.ssh/config',
    chooseAServer: 'Choose a server',
    manageServers: 'Manage servers',
    noSSHHostsFoundAddOneManuallyInRemoteSettings:
      'No SSH hosts found. Add one manually in remote settings.',
    chooseAProjectLocationFirst: 'Choose a project location first'
  },
  {
    unableToLoadServersCloseAndTryAgain: '无法读取服务器列表，请关闭后重试。',
    unableToCreateProjectTryAgain: '创建项目失败，请重试。',
    newProject: '新建项目',
    projectName: '项目名称',
    permissionApproval: '权限审批',
    askBeforeImportantActions: '重要操作前询问',
    approveForMe: '帮我批准',
    fullAccess: '完全访问权限',
    askBeforeRunningCommandsWritingOrEditingFiles: '执行命令、写入或修改文件前会先向你确认。',
    runAllowedToolsAutomaticallyWithoutAskingEachTime: '自动执行允许的工具，不会逐次确认。',
    accessFilesAndExecuteCommandsOnTheSelectedServerWith:
      '可在所选服务器上访问当前账号有权限的文件并执行命令。',
    unrestrictedAccessToTheInternetAndAnyFileOnYour: '可不受限制地访问互联网和你电脑上的任何文件。',
    cancel: '取消',
    create: '创建',
    projectsRememberALocalWorkingDirectoryTemporaryConversationsDoNot:
      '项目会记住一个本机工作目录；临时对话不需要选择目录。',
    remoteProjectsRememberADirectoryOnTheSelectedServerProject:
      '远程项目会记住所选服务器上的目录；对话中的项目文件和命令操作将在该服务器执行。',
    localFolder: '本机文件夹',
    remoteServer: '远程服务器',
    workingDirectory: '工作目录',
    useTheButtonOnTheRightToChooseAFolder: '点击右侧按钮选择文件夹',
    chooseFolder: '选择文件夹',
    connectingToServer: '正在连接服务器',
    downloadingRemoteRuntime: (percent: number, attempt: number) =>
      `正在下载远程运行时 ${percent}% · 第 ${attempt} 次尝试`,
    downloadingRemoteRuntimeWithoutTotal: (attempt: number) =>
      `正在下载远程运行时 · 第 ${attempt} 次尝试`,
    connectionNotChecked: '连接尚未检查',
    reconnect: '重新连接',
    settingsRemote: '设置 → 远程',
    historyAndDraftsRemainAvailableVerifyUncertainFileChangesOr:
      '对话历史和草稿仍可查看；写入或命令结果未知时先在服务器核对。',
    projectDirectoryOnServer: '服务器上的项目目录',
    enterAnAbsoluteServerPathStartingWith: '请输入以 / 开头的服务器绝对路径。',
    enterAnAbsolutePathOrChooseOneInTheDirectory: '可直接输入绝对路径，或在下方目录树中选择。',
    filterFolders: '筛选文件夹...',
    sSHServer: 'SSH 服务器',
    loadingServers: '正在读取服务器…',
    chooseAHostFromSshConfig: '可直接选择 ~/.ssh/config 中的主机',
    chooseAServer: '请选择服务器',
    manageServers: '管理服务器',
    noSSHHostsFoundAddOneManuallyInRemoteSettings: '未识别到 SSH 主机；可在远程设置中手动添加。',
    chooseAProjectLocationFirst: '请先选择项目位置'
  }
)
