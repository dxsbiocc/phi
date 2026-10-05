import { useCallback, useEffect, useState } from 'react'

import type {
  OfficeDocumentState,
  OfficeRendererBridge
} from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import { officeDocumentRegistry } from '../lib/officeDocumentRegistry'

const OFFICE_STATUS_REFRESH_MS = 1_000

export interface OfficeDocumentHookState {
  status: OfficeDocumentState
  publishStatus: (status: OfficeDocumentState) => void
  recreateFromSource: (freshSourcePath?: string) => void
}

interface OfficeDocumentLifecycle {
  active: boolean
  artifactId?: string
  sessionId?: string
  stopPolling: () => void
}

function officeStatusSignature(status: OfficeDocumentState): string {
  if (status.state !== 'ready') return `${status.state}:${status.sourcePath}`
  const document = status.document
  return JSON.stringify([
    document.artifactId,
    document.kind ?? 'xlsx',
    document.followAiControllable === true,
    document.humanEdit ?? null,
    document.previewUrl,
    document.previewState ?? null,
    document.previewError ?? null,
    document.slideCount ?? null,
    document.readOnly,
    document.freezeState ?? null,
    document.needsSave === true,
    document.saveState,
    document.lastSavedRevision,
    document.lastSavedAt ?? null,
    document.lastReconciliation?.conclusion ?? null,
    document.lastReconciliation?.message ?? null,
    document.lastHumanEdit?.type ?? null,
    document.lastHumanEdit?.conclusion ?? null,
    document.lastHumanEdit?.code ?? null,
    document.lastHumanEdit?.message ?? null,
    document.restoreNotice?.kind ?? null,
    document.restoreNotice?.kind === 'recovered' ? document.restoreNotice.hasUnsavedChanges : null
  ])
}

function pollOfficeStatus(
  api: OfficeRendererBridge,
  sourcePath: string,
  onStatus: (status: OfficeDocumentState) => void
): () => void {
  let active = true
  let lastSignature: string | undefined
  const refresh = async (): Promise<void> => {
    try {
      const result = await api.status({ sourcePath })
      if (!active || !result.ok || !result.value) return
      const signature = officeStatusSignature(result.value)
      if (signature === lastSignature) return
      lastSignature = signature
      onStatus(result.value)
    } catch {
      // A transient status failure must not replace a working preview with an error pane.
    }
  }
  const timer = window.setInterval(() => void refresh(), OFFICE_STATUS_REFRESH_MS)
  return () => {
    active = false
    window.clearInterval(timer)
  }
}

async function openOfficeDocument(
  api: OfficeRendererBridge,
  sourcePath: string,
  publishStatus: (status: OfficeDocumentState) => void,
  lifecycle: OfficeDocumentLifecycle,
  fresh: boolean
): Promise<void> {
  try {
    const result = await api.open({ sourcePath, ...(fresh ? { fresh: true } : {}) })
    if (!result.ok) {
      if (lifecycle.active) publishStatus({ state: 'error', sourcePath, ...result.error })
      return
    }
    if (result.value.state === 'ready') {
      lifecycle.artifactId = result.value.document.artifactId
      lifecycle.sessionId = result.value.document.sessionId
    }
    if (lifecycle.active) {
      publishStatus(result.value)
      if (result.value.state === 'ready') {
        lifecycle.stopPolling = pollOfficeStatus(api, sourcePath, publishStatus)
      }
    } else if (lifecycle.artifactId && lifecycle.sessionId) {
      await api.close({ artifactId: lifecycle.artifactId, sessionId: lifecycle.sessionId })
    }
  } catch {
    if (lifecycle.active) {
      publishStatus({
        state: 'error',
        sourcePath,
        code: 'unavailable',
        message: 'Office 实时预览暂不可用'
      })
    }
  }
}

function startOfficeDocumentLifecycle(
  sourcePath: string,
  registryPath: string,
  publishStatus: (status: OfficeDocumentState) => void,
  fresh: boolean
): () => void {
  const api = getRendererApi().office
  const lifecycle: OfficeDocumentLifecycle = {
    active: true,
    stopPolling: () => undefined
  }
  const unsubscribeSelection = api.onSelection((event) => {
    if (!lifecycle.active || event.artifactId !== lifecycle.artifactId) return
    officeDocumentRegistry.publishSelection(event.artifactId, event.selection)
  })
  officeDocumentRegistry.publish({ state: 'preparing', sourcePath }, registryPath)
  void openOfficeDocument(api, sourcePath, publishStatus, lifecycle, fresh)
  return () => {
    lifecycle.active = false
    lifecycle.stopPolling()
    unsubscribeSelection()
    officeDocumentRegistry.clear(registryPath, lifecycle.artifactId)
    if (lifecycle.artifactId && lifecycle.sessionId) {
      void api
        .close({ artifactId: lifecycle.artifactId, sessionId: lifecycle.sessionId })
        .catch(() => undefined)
    }
  }
}

export function useOfficeDocument(sourcePath: string): OfficeDocumentHookState {
  const [state, setState] = useState<OfficeDocumentState>({
    state: 'preparing',
    sourcePath
  })
  const [freshRequest, setFreshRequest] = useState(0)
  const [openPath, setOpenPath] = useState(sourcePath)
  const publishStatus = useCallback(
    (next: OfficeDocumentState): void => {
      setState(next)
      officeDocumentRegistry.publish(next, sourcePath)
    },
    [sourcePath]
  )

  useEffect(
    () => startOfficeDocumentLifecycle(openPath, sourcePath, publishStatus, freshRequest > 0),
    [freshRequest, openPath, publishStatus, sourcePath]
  )

  return {
    status: state,
    publishStatus,
    recreateFromSource: (freshSourcePath = sourcePath) => {
      setState({ state: 'preparing', sourcePath: freshSourcePath })
      setOpenPath(freshSourcePath)
      setFreshRequest((current) => current + 1)
    }
  }
}
