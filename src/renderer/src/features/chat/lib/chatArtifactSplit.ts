import { isOfficeDocumentPath } from '../../../lib/officeDocumentPath'
import type { FileOpenConversationLayout } from '../../../../../shared/appSettingsTypes'

export const CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX = 360
export const CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX = 320
export const CHAT_ARTIFACT_SPLIT_SEPARATOR_PX = 8
export const CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO = 0.56
export const CHAT_ARTIFACT_SPLIT_KEYBOARD_STEP = 0.02
export const CHAT_ARTIFACT_SPLIT_STORAGE_KEY = 'phi.chatArtifactSplitRatio'

export interface ChatArtifactSplitStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function sidebarHostsCurrentConversation({
  activeView,
  isSidebarOpen,
  workspaceSidebarMode
}: {
  activeView: string
  isSidebarOpen: boolean
  workspaceSidebarMode: string
}): boolean {
  return isSidebarOpen && activeView === 'analysis' && workspaceSidebarMode === 'conversations'
}

export function sidebarStateForFileOpenConversationLayout(layout: FileOpenConversationLayout): {
  isSidebarOpen: true
  workspaceSidebarMode: 'conversations' | 'files'
} {
  return {
    isSidebarOpen: true,
    workspaceSidebarMode: layout === 'sidebar' ? 'conversations' : 'files'
  }
}

export function shouldEnableOfficeChatSplit({
  officeEnabled,
  activeTabKind,
  activeTabPath,
  previewPath,
  currentConversationInSidebar = false
}: {
  officeEnabled: boolean
  activeTabKind: string | null | undefined
  activeTabPath: string | null | undefined
  previewPath: string | null | undefined
  currentConversationInSidebar?: boolean
}): boolean {
  return Boolean(
    officeEnabled &&
    !currentConversationInSidebar &&
    activeTabKind === 'file' &&
    activeTabPath &&
    previewPath === activeTabPath &&
    isOfficeDocumentPath(previewPath)
  )
}

function validStoredRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
}

export function readChatArtifactSplitRatio(
  storage: Pick<ChatArtifactSplitStorage, 'getItem'> | null | undefined
): number {
  if (!storage) return CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO
  try {
    const value = Number(storage.getItem(CHAT_ARTIFACT_SPLIT_STORAGE_KEY))
    return validStoredRatio(value) ? value : CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO
  } catch {
    return CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO
  }
}

export function writeChatArtifactSplitRatio(
  storage: Pick<ChatArtifactSplitStorage, 'setItem'> | null | undefined,
  ratio: number
): boolean {
  if (!storage || !validStoredRatio(ratio)) return false
  try {
    storage.setItem(CHAT_ARTIFACT_SPLIT_STORAGE_KEY, String(ratio))
    return true
  } catch {
    return false
  }
}

export function clampChatArtifactSplitRatio(ratio: number, containerWidth: number): number {
  const availableWidth = Math.max(0, containerWidth - CHAT_ARTIFACT_SPLIT_SEPARATOR_PX)
  const totalMinimumWidth = CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX + CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX
  if (availableWidth <= totalMinimumWidth) {
    return CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX / totalMinimumWidth
  }
  const minimumRatio = CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX / availableWidth
  const maximumRatio = 1 - CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX / availableWidth
  return Math.min(maximumRatio, Math.max(minimumRatio, ratio))
}

export function chatArtifactSplitWidths(
  ratio: number,
  containerWidth: number
): { left: number; right: number } {
  const availableWidth = Math.max(0, containerWidth - CHAT_ARTIFACT_SPLIT_SEPARATOR_PX)
  const clampedRatio = clampChatArtifactSplitRatio(ratio, containerWidth)
  const left = availableWidth * clampedRatio
  return { left, right: availableWidth - left }
}

export function keyboardAdjustedChatArtifactSplitRatio(
  ratio: number,
  key: string,
  containerWidth: number
): number {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return ratio
  const direction = key === 'ArrowLeft' ? -1 : 1
  return clampChatArtifactSplitRatio(
    ratio + direction * CHAT_ARTIFACT_SPLIT_KEYBOARD_STEP,
    containerWidth
  )
}
