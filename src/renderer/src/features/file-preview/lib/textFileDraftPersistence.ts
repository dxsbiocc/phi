import { filePreviewCopy } from './filePreviewUiCopy'
import { WORKSPACE_TEXT_MAX_BYTES } from '../../../../../shared/workspaceFileOperations'
import type { TextFileDraft } from './textFileDrafts'
import { textContentsEqual } from './textFiles'

export const TEXT_FILE_DRAFT_STORAGE_KEY = 'phi.text-file-drafts.v1'

function validText(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = new TextEncoder().encode(value)
  return (
    bytes.byteLength <= WORKSPACE_TEXT_MAX_BYTES &&
    !value.includes('\0') &&
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === value
  )
}

function validPath(path: string): boolean {
  if (!validText(path)) return false
  let target = path
  if (path.startsWith('ssh://')) {
    try {
      const url = new URL(path)
      if (!url.hostname || url.password || url.port || url.search || url.hash) return false
      const segments = path.slice(path.indexOf('/', 6)).split('/').map(decodeURIComponent)
      if (segments.some((part) => part.includes('/') || part === '.' || part === '..')) return false
      target = segments.join('/')
    } catch {
      return false
    }
  }
  return (
    (target.startsWith('/') ||
      /^[a-z]:[\\/]/i.test(target) ||
      /^\\\\[^\\]+\\[^\\]+/.test(target)) &&
    !target.split(/[\\/]/).includes('..')
  )
}

function recoveredDraft(path: string, value: unknown): TextFileDraft | null {
  if (!validPath(path) || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const draft = value as Record<string, unknown>
  if (!validText(draft.baseContent) || !validText(draft.content)) return null
  if (draft.saving !== true && textContentsEqual(draft.baseContent, draft.content)) return null
  return { baseContent: draft.baseContent, content: draft.content, saving: false, error: null }
}

export function loadTextFileDrafts(
  storage: Pick<Storage, 'getItem'>
): Record<string, TextFileDraft> {
  let raw: string | null
  try {
    raw = storage.getItem(TEXT_FILE_DRAFT_STORAGE_KEY) ?? storage.getItem('phi.markdown-drafts.v1')
  } catch {
    throw new Error(filePreviewCopy.readTextDraftFailed)
  }
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([path, value]) => {
      const draft = recoveredDraft(path, value)
      return draft ? [[path, draft]] : []
    })
  )
}

export function saveTextFileDrafts(
  storage: Pick<Storage, 'setItem'>,
  drafts: Record<string, TextFileDraft>
): void {
  const pending = Object.fromEntries(
    Object.entries(drafts).flatMap(([path, value]) => {
      const draft = recoveredDraft(path, value)
      return draft ? [[path, { ...draft, saving: value.saving }]] : []
    })
  )
  try {
    storage.setItem(TEXT_FILE_DRAFT_STORAGE_KEY, JSON.stringify(pending))
  } catch {
    throw new Error(filePreviewCopy.saveTextDraftFailed)
  }
}
