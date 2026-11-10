import { defineCopy } from '../../../lib/i18n'

const english = {
  messages: 'Messages',
  loadingMessages: 'Loading messages…',
  noMessages: 'No messages',
  packageUpdatesStatus: 'Update available',
  appUpdateStatus: 'Available',
  appUpdateAvailable: (version: string) => `Phi ${version} is available`,
  currentVersion: (version: string) => `Current version ${version}`,
  packageNames: (names: readonly string[]) => names.join(', '),
  openMessage: (title: string) => `Open ${title}`
} as const

export const messagesCopy = defineCopy(english, {
  messages: '消息',
  loadingMessages: '正在读取消息…',
  noMessages: '暂无消息',
  packageUpdatesStatus: '可更新',
  appUpdateStatus: '可用',
  appUpdateAvailable: (version) => `Phi ${version} 可用`,
  currentVersion: (version) => `当前版本 ${version}`,
  packageNames: (names) => names.join('、'),
  openMessage: (title) => `打开${title}`
})
