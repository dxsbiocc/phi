import { normalizeUiLanguage, type UiLanguage } from '../shared/uiLanguage'

const english = {
  startupFailed: 'Phi could not finish loading the interface',
  startupRecovery: 'Reload the window, or close it and start Phi again.',
  reload: 'Reload',
  close: 'Close',
  select: 'Select',
  save: 'Save',
  import: 'Import',
  selectInput: 'Select input files or folders',
  selectUpload: 'Select local files or folders to upload',
  saveResult: 'Save remote result',
  saveRemoteFile: 'Save remote file',
  selectExecutable: 'Select a tool executable',
  exportChat: 'Select a destination folder for chat export',
  selectProject: 'Select a project folder',
  selectPlugin: 'Select a Phi Plugin directory',
  selectSkill: 'Select a local Skill directory',
  selectTeamSource: 'Select a team package folder',
  exportMemberIdentity: 'Export member identity backup',
  importMemberIdentity: 'Import member identity backup',
  exportTeamSigningKey: 'Export team signing key backup',
  importTeamSigningKey: 'Import team signing key backup',
  selectTeamPublishFolder: 'Select the team publishing folder',
  ageBackupFile: 'age backup',
  exportTeamSubmission: 'Export team submission',
  importTeamSubmission: 'Import team submission',
  teamSubmissionFile: 'Phi submission',
  importPackage: 'Import package',
  packageFilter: 'Phi package',
  exportReproducibility: 'Export Wrapper reproducibility record'
} as const

type NativeUiCopy = { readonly [Key in keyof typeof english]: string }

const chinese: NativeUiCopy = {
  startupFailed: 'Phi 界面未能完成加载',
  startupRecovery: '可以重新加载窗口，或关闭后再次启动。',
  reload: '重新加载',
  close: '关闭',
  select: '选择',
  save: '保存',
  import: '导入',
  selectInput: '选择输入文件或文件夹',
  selectUpload: '选择要上传的本地文件或文件夹',
  saveResult: '保存远程结果',
  saveRemoteFile: '保存远程文件',
  selectExecutable: '选择工具可执行文件',
  exportChat: '选择会话导出的目标文件夹',
  selectProject: '选择项目文件夹',
  selectPlugin: '选择 Phi 插件目录',
  selectSkill: '选择本地技能目录',
  selectTeamSource: '选择团队包文件夹',
  exportMemberIdentity: '导出成员身份备份',
  importMemberIdentity: '导入成员身份备份',
  exportTeamSigningKey: '导出团队签名密钥备份',
  importTeamSigningKey: '导入团队签名密钥备份',
  selectTeamPublishFolder: '选择团队发布文件夹',
  ageBackupFile: 'age 备份',
  exportTeamSubmission: '导出团队投稿',
  importTeamSubmission: '导入团队投稿',
  teamSubmissionFile: 'Phi 投稿',
  importPackage: '导入软件包',
  packageFilter: 'Phi 软件包',
  exportReproducibility: '导出 Wrapper 复现记录'
}

/** Native dialogs resolve language when opened, independently of the renderer lifetime. */
export function nativeUiCopy(language: UiLanguage): NativeUiCopy {
  return normalizeUiLanguage(language) === 'zh-CN' ? chinese : english
}
