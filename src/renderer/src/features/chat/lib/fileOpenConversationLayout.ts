import type { FileOpenConversationLayout } from '../../../../../shared/appSettingsTypes'

export function sidebarStateForFileOpenConversationLayout(layout: FileOpenConversationLayout): {
  isSidebarOpen: true
  workspaceSidebarMode: 'conversations'
} | null {
  if (layout === 'tab') return null
  return {
    isSidebarOpen: true,
    workspaceSidebarMode: 'conversations'
  }
}
