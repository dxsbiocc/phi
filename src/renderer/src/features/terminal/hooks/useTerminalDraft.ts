import { useCallback, useEffect, useSyncExternalStore } from 'react'

import type {
  TerminalCommandDraft,
  TerminalRendererBridge,
  TerminalResult
} from '../../../../../shared/terminalTypes'
import {
  type TerminalDraftLiveWorkspace,
  terminalDraftErrorMessage,
  terminalDraftRetentionRemovals,
  TERMINAL_DRAFT_STORE_MAX_AGE_MS
} from '../lib/terminalDraft'

export type TerminalAssistKind = 'command' | 'explain'
export type TerminalDraftPhase = 'editing' | 'generating' | 'result'

export interface TerminalDraftState {
  terminalId: string
  workspaceKey: string
  kind: TerminalAssistKind
  open: boolean
  phase: TerminalDraftPhase
  request: string
  selection?: string
  draft?: TerminalCommandDraft
  command: string
  inputValues: Record<string, string>
  readyForDirtyLine: boolean
  selectionTruncated: boolean
  submitting: boolean
  submitted: boolean
  error?: string
  generationRequestId?: string
  submitRequestId?: string
}

interface DraftStore {
  entries: Map<string, DraftStoreEntry>
  listeners: Set<() => void>
  version: number
  pendingGeneration: { requestId: string; terminalId: string } | null
  expiryTimer?: ReturnType<typeof setTimeout>
  cancelGeneration(requestId: string): void
}

interface DraftStoreEntry {
  state: TerminalDraftState
  lastTouchedAt: number
}

const stores = new WeakMap<TerminalRendererBridge, DraftStore>()

function storeFor(bridge: TerminalRendererBridge): DraftStore {
  let store = stores.get(bridge)
  if (!store) {
    store = {
      entries: new Map(),
      listeners: new Set(),
      version: 0,
      pendingGeneration: null,
      cancelGeneration: (requestIdToCancel) => {
        void safely(() => bridge.cancelDraft(requestIdToCancel))
      }
    }
    stores.set(bridge, store)
  }
  return store
}

function publish(store: DraftStore): void {
  store.version += 1
  for (const listener of store.listeners) listener()
}

function scheduleExpiry(store: DraftStore): void {
  if (store.expiryTimer !== undefined) clearTimeout(store.expiryTimer)
  store.expiryTimer = undefined
  if (store.entries.size === 0) return

  const expiresAt = Math.min(
    ...[...store.entries.values()].map(
      (entry) => entry.lastTouchedAt + TERMINAL_DRAFT_STORE_MAX_AGE_MS
    )
  )
  store.expiryTimer = setTimeout(
    () => {
      store.expiryTimer = undefined
      if (pruneEntries(store, Date.now())) publish(store)
      scheduleExpiry(store)
    },
    Math.max(0, expiresAt - Date.now())
  )
}

function pruneEntries(
  store: DraftStore,
  now: number,
  liveWorkspace?: TerminalDraftLiveWorkspace
): boolean {
  const removals = terminalDraftRetentionRemovals(
    [...store.entries.values()].map((entry) => ({
      terminalId: entry.state.terminalId,
      workspaceKey: entry.state.workspaceKey,
      lastTouchedAt: entry.lastTouchedAt
    })),
    { now, ...(liveWorkspace ? { liveWorkspace } : {}) }
  )
  if (removals.length === 0) return false

  for (const terminalId of removals) store.entries.delete(terminalId)
  const pending = store.pendingGeneration
  if (pending && removals.includes(pending.terminalId)) {
    store.pendingGeneration = null
    store.cancelGeneration(pending.requestId)
  }
  return true
}

function replaceEntry(store: DraftStore, entry: TerminalDraftState): void {
  const now = Date.now()
  store.entries.set(entry.terminalId, { state: entry, lastTouchedAt: now })
  pruneEntries(store, now)
  scheduleExpiry(store)
  publish(store)
}

function setPendingGeneration(
  store: DraftStore,
  pendingGeneration: DraftStore['pendingGeneration']
): void {
  store.pendingGeneration = pendingGeneration
}

function pendingGenerationFor(store: DraftStore): DraftStore['pendingGeneration'] {
  return store.pendingGeneration
}

function requestId(): string {
  return globalThis.crypto.randomUUID()
}

function failedResult(message = 'Terminal Agent 暂时不可用'): TerminalResult<never> {
  return { ok: false, code: 'unavailable', message }
}

async function safely<T>(action: () => Promise<TerminalResult<T>>): Promise<TerminalResult<T>> {
  try {
    return await action()
  } catch {
    return failedResult()
  }
}

export interface OpenTerminalDraftInput {
  terminalId: string
  workspaceKey: string
  kind: TerminalAssistKind
  selection?: string
}

export interface UseTerminalDraftValue {
  state: TerminalDraftState | null
  generationBusy: boolean
  open(input: OpenTerminalDraftInput): void
  close(): void
  setRequest(value: string): void
  setSelection(value: string | undefined): void
  setCommand(value: string): void
  setInputValue(name: string, value: string): void
  setReadyForDirtyLine(value: boolean): void
  generate(): Promise<void>
  cancelGeneration(): Promise<void>
  submit(source: string, bracketedPaste: boolean): Promise<boolean>
}

export function useTerminalDraft(
  bridge: TerminalRendererBridge,
  activeTerminalId: string | null,
  liveWorkspace?: { workspaceKey: string; terminalIds: readonly string[] }
): UseTerminalDraftValue {
  const store = storeFor(bridge)
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    [store]
  )
  const getSnapshot = useCallback(() => store.version, [store])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const state = activeTerminalId ? (store.entries.get(activeTerminalId)?.state ?? null) : null

  useEffect(() => {
    if (!liveWorkspace) return
    const changed = pruneEntries(store, Date.now(), {
      workspaceKey: liveWorkspace.workspaceKey,
      terminalIds: new Set(liveWorkspace.terminalIds)
    })
    scheduleExpiry(store)
    if (changed) publish(store)
  }, [liveWorkspace, store])

  const updateActive = useCallback(
    (update: (current: TerminalDraftState) => TerminalDraftState): void => {
      if (!activeTerminalId) return
      const current = store.entries.get(activeTerminalId)?.state
      if (current) replaceEntry(store, update(current))
    },
    [activeTerminalId, store]
  )

  const open = useCallback(
    (input: OpenTerminalDraftInput): void => {
      const current = store.entries.get(input.terminalId)?.state
      if (current && current.kind === input.kind && input.selection === undefined) {
        replaceEntry(store, { ...current, open: true, readyForDirtyLine: false })
        return
      }
      replaceEntry(store, {
        terminalId: input.terminalId,
        workspaceKey: input.workspaceKey,
        kind: input.kind,
        open: true,
        phase: 'editing',
        request: input.kind === 'explain' ? '解释这段终端内容' : '',
        ...(input.selection === undefined ? {} : { selection: input.selection }),
        command: '',
        inputValues: {},
        readyForDirtyLine: false,
        selectionTruncated: false,
        submitting: false,
        submitted: false
      })
    },
    [store]
  )

  const close = useCallback((): void => {
    updateActive((current) => ({ ...current, open: false, readyForDirtyLine: false }))
  }, [updateActive])

  const setRequest = useCallback(
    (value: string): void => updateActive((current) => ({ ...current, request: value })),
    [updateActive]
  )
  const setSelection = useCallback(
    (value: string | undefined): void =>
      updateActive((current) => {
        const next = { ...current }
        if (value === undefined) delete next.selection
        else next.selection = value
        return next
      }),
    [updateActive]
  )
  const setCommand = useCallback(
    (value: string): void =>
      updateActive((current) => ({
        ...current,
        command: value,
        submitRequestId: undefined,
        error: undefined
      })),
    [updateActive]
  )
  const setInputValue = useCallback(
    (name: string, value: string): void =>
      updateActive((current) => ({
        ...current,
        inputValues: { ...current.inputValues, [name]: value },
        submitRequestId: undefined,
        error: undefined
      })),
    [updateActive]
  )
  const setReadyForDirtyLine = useCallback(
    (value: boolean): void => updateActive((current) => ({ ...current, readyForDirtyLine: value })),
    [updateActive]
  )

  const generate = useCallback(async (): Promise<void> => {
    if (!activeTerminalId || store.pendingGeneration) return
    const current = store.entries.get(activeTerminalId)?.state
    if (!current || !current.request.trim()) return

    const generationRequestId = requestId()
    setPendingGeneration(store, {
      requestId: generationRequestId,
      terminalId: activeTerminalId
    })
    replaceEntry(store, {
      ...current,
      phase: 'generating',
      generationRequestId,
      selectionTruncated: false,
      submitting: false,
      submitted: false,
      readyForDirtyLine: false,
      error: undefined
    })

    const result = await safely(() =>
      bridge.generateDraft({
        requestId: generationRequestId,
        terminalId: current.terminalId,
        kind: current.kind,
        request: current.request,
        ...(current.selection ? { selection: current.selection } : {})
      })
    )
    if (pendingGenerationFor(store)?.requestId !== generationRequestId) return
    setPendingGeneration(store, null)

    const latest = store.entries.get(activeTerminalId)?.state
    if (!latest || latest.generationRequestId !== generationRequestId) {
      publish(store)
      return
    }
    if (!result.ok) {
      replaceEntry(store, {
        ...latest,
        phase: 'editing',
        generationRequestId: undefined,
        error: terminalDraftErrorMessage(result.message)
      })
      return
    }

    replaceEntry(store, {
      ...latest,
      phase: 'result',
      generationRequestId: undefined,
      draft: result.value,
      command: result.value.source,
      inputValues: Object.fromEntries(result.value.requiredInputs.map((input) => [input.name, ''])),
      selectionTruncated: Boolean(result.value.selectionTruncated),
      submitRequestId: undefined,
      error: undefined
    })
  }, [activeTerminalId, bridge, store])

  const cancelGeneration = useCallback(async (): Promise<void> => {
    if (!activeTerminalId) return
    const pending = store.pendingGeneration
    if (!pending || pending.terminalId !== activeTerminalId) return
    setPendingGeneration(store, null)
    const current = store.entries.get(activeTerminalId)?.state
    if (current) {
      replaceEntry(store, {
        ...current,
        phase: 'editing',
        generationRequestId: undefined,
        error: undefined
      })
    } else {
      publish(store)
    }
    await safely(() => bridge.cancelDraft(pending.requestId))
  }, [activeTerminalId, bridge, store])

  const submit = useCallback(
    async (source: string, bracketedPaste: boolean): Promise<boolean> => {
      if (!activeTerminalId) return false
      const current = store.entries.get(activeTerminalId)?.state
      if (!current?.draft || current.submitting || current.submitted) return false
      const submitRequestId = current.submitRequestId ?? requestId()
      replaceEntry(store, { ...current, submitting: true, submitRequestId, error: undefined })
      const result = await safely(() =>
        bridge.submitDraft({
          requestId: submitRequestId,
          draftId: current.draft!.draftId,
          source,
          bracketedPaste
        })
      )
      const latest = store.entries.get(activeTerminalId)?.state
      if (!latest || latest.submitRequestId !== submitRequestId) return false
      if (!result.ok) {
        replaceEntry(store, {
          ...latest,
          submitting: false,
          error: terminalDraftErrorMessage(result.message)
        })
        return false
      }
      replaceEntry(store, {
        ...latest,
        submitting: false,
        submitted: true,
        readyForDirtyLine: false,
        error: undefined
      })
      return true
    },
    [activeTerminalId, bridge, store]
  )

  return {
    state,
    generationBusy: store.pendingGeneration !== null,
    open,
    close,
    setRequest,
    setSelection,
    setCommand,
    setInputValue,
    setReadyForDirtyLine,
    generate,
    cancelGeneration,
    submit
  }
}
