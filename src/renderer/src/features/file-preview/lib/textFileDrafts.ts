import { filePreviewCopy } from './filePreviewUiCopy'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { textContentsEqual } from './textFiles'
import { loadTextFileDrafts, saveTextFileDrafts } from './textFileDraftPersistence'
import { WORKSPACE_TEXT_MAX_BYTES } from '../../../../../shared/workspaceFileOperations'

export type TextFileDraft = {
  baseContent: string
  content: string
  saving: boolean
  error: string | null
}

export function textFileDraftIsDirty(draft: TextFileDraft | undefined): boolean {
  return Boolean(draft && !textContentsEqual(draft.content, draft.baseContent))
}

type DraftState = {
  drafts: Record<string, TextFileDraft>
  persistenceError: string | null
  sync: (path: string, content: string) => void
  edit: (path: string, baseContent: string, content: string) => void
  beginSave: (path: string) => TextFileDraft | null
  saved: (path: string, submitted: string, content: string) => void
  failed: (path: string, error: string) => void
  discard: (path: string, content: string) => void
  release: (path: string) => void
}

export function createTextFileDraftStore(
  storage?: Pick<Storage, 'getItem' | 'setItem'>
): UseBoundStore<StoreApi<DraftState>> {
  const store = create<DraftState>((set, get) => ({
    drafts: {},
    persistenceError: null,
    sync: (path, content) => {
      const existing = get().drafts[path]
      if (existing?.saving || textFileDraftIsDirty(existing) || existing?.baseContent === content)
        return
      set((state) => ({
        drafts: {
          ...state.drafts,
          [path]: { baseContent: content, content, saving: false, error: null }
        }
      }))
    },
    edit: (path, baseContent, content) =>
      set((state) => {
        const existing = state.drafts[path] ?? {
          baseContent,
          content: baseContent,
          saving: false,
          error: null
        }
        if (new TextEncoder().encode(content).byteLength > WORKSPACE_TEXT_MAX_BYTES) {
          return {
            drafts: {
              ...state.drafts,
              [path]: {
                ...existing,
                error: filePreviewCopy.textLimit
              }
            }
          }
        }
        return { drafts: { ...state.drafts, [path]: { ...existing, content, error: null } } }
      }),
    beginSave: (path) => {
      const draft = get().drafts[path]
      if (!draft || draft.saving || !textFileDraftIsDirty(draft)) return null
      set((state) => ({
        drafts: { ...state.drafts, [path]: { ...draft, saving: true, error: null } }
      }))
      return draft
    },
    saved: (path, submitted, content) =>
      set((state) => {
        const draft = state.drafts[path]
        if (!draft) return state
        return {
          drafts: {
            ...state.drafts,
            [path]: {
              baseContent: content,
              content: textContentsEqual(draft.content, submitted) ? content : draft.content,
              saving: false,
              error: null
            }
          }
        }
      }),
    failed: (path, error) =>
      set((state) => {
        const draft = state.drafts[path]
        return draft
          ? { drafts: { ...state.drafts, [path]: { ...draft, saving: false, error } } }
          : state
      }),
    discard: (path, content) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [path]: { baseContent: content, content, saving: false, error: null }
        }
      })),
    release: (path) => {
      const draft = get().drafts[path]
      if (!draft || draft.saving || textFileDraftIsDirty(draft)) return
      set((state) => {
        const drafts = { ...state.drafts }
        delete drafts[path]
        return { drafts }
      })
    }
  }))
  if (storage) {
    try {
      store.setState({ drafts: loadTextFileDrafts(storage) })
    } catch (error) {
      store.setState({
        persistenceError: error instanceof Error ? error.message : filePreviewCopy.readDraftFailed
      })
    }
    store.subscribe((state, previous) => {
      if (state.drafts === previous.drafts) return
      try {
        saveTextFileDrafts(storage, state.drafts)
        if (state.persistenceError) store.setState({ persistenceError: null })
      } catch (error) {
        store.setState({
          persistenceError: error instanceof Error ? error.message : filePreviewCopy.saveDraftFailed
        })
      }
    })
  }
  return store
}

function browserDraftStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  }
}

export const useTextFileDrafts = createTextFileDraftStore(browserDraftStorage())

export function textFileHasUnsavedChanges(path: string): boolean {
  const draft = useTextFileDrafts.getState().drafts[path]
  return Boolean(draft?.saving || textFileDraftIsDirty(draft))
}
