import { defineCopy } from './i18n'

const english = {
  applicationUpdate: 'Application update',
  close: 'Close',
  whatsNew: "What's new",
  viewOnGitHub: 'View on GitHub',
  openReleasesPage: 'Open Releases page',
  downloadInBrowser: 'Download in browser',
  dataPreservedNotice:
    'Your conversations, projects, environments, and settings in ~/.phi will be preserved.',
  noReleaseNotes: 'Release notes are not available for this version.',
  downloadUpdate: 'Download update',
  downloadUpdateWithSize: (sizeText: string) => `Download update (${sizeText})`,
  retryDownload: 'Retry download',
  cancelDownload: 'Cancel',
  downloadingAsset: (name: string) => `Downloading ${name}…`,
  downloadingGeneric: 'Downloading update…',
  verifyingChecksum: 'Verifying installer integrity (SHA-256)…',
  checksumVerified: 'SHA-256 verified',
  readyAutoReplaceHint:
    'Phi will close active local runs, replace the current installation, and relaunch automatically (remote runs continue).',
  readyOpenInstallerHint:
    'Phi will open the verified installer and close this older version so you can finish replacing the app (remote runs continue).',
  restartAndInstall: 'Restart & install update',
  openInstallerAndQuit: 'Open installer & quit',
  launchingInstaller: 'Launching installer…',
  updateFailed: 'Update failed'
} as const

export const appUpdateCopy = defineCopy(english, {
  applicationUpdate: '应用版本更新',
  close: '关闭',
  whatsNew: '更新内容',
  viewOnGitHub: '在 GitHub 查看',
  openReleasesPage: '前往发布页',
  downloadInBrowser: '在浏览器下载',
  dataPreservedNotice: '升级过程会完整保留 ~/.phi 中的会话、项目、受管环境与配置数据。',
  noReleaseNotes: '当前版本暂无更新说明。',
  downloadUpdate: '下载更新',
  downloadUpdateWithSize: (sizeText) => `下载更新 (${sizeText})`,
  retryDownload: '重试下载',
  cancelDownload: '取消',
  downloadingAsset: (name) => `正在下载 ${name}…`,
  downloadingGeneric: '正在下载更新包…',
  verifyingChecksum: '正在校验安装包完整性 (SHA-256)…',
  checksumVerified: 'SHA-256 校验通过',
  readyAutoReplaceHint:
    '安装时将关闭当前应用（停止本地运行中任务，远程任务不受影响），自动覆盖旧版本并重新启动。',
  readyOpenInstallerHint:
    '将直接打开已通过校验的本地安装包并退出当前旧版本，完成拖入或确认即可替换旧版（远程任务不受影响）。',
  restartAndInstall: '立即重启并替换安装',
  openInstallerAndQuit: '打开安装包并退出旧版',
  launchingInstaller: '正在启动安装程序…',
  updateFailed: '更新失败'
})
