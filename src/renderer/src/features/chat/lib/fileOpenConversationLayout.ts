import type { FileOpenConversationLayout } from '../../../../../shared/appSettingsTypes'

export function sidebarStateForFileOpenConversationLayout(layout: FileOpenConversationLayout): {
  isSidebarOpen: true
  workspaceSidebarMode: 'conversations' | 'files'
} {
  return {
    isSidebarOpen: true,
    workspaceSidebarMode: layout === 'sidebar' ? 'conversations' : 'files'
  }
}
