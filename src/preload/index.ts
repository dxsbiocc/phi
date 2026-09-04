import { contextBridge, ipcRenderer } from 'electron'

type AgentEventSummary = Record<string, unknown>
type Unsubscribe = () => void

const api = {
  sendPrompt: (text: string): Promise<void> => ipcRenderer.invoke('agent:prompt', text),
  onAgentEvent: (cb: (event: AgentEventSummary) => void): Unsubscribe => {
    const handler = (_: unknown, event: AgentEventSummary): void => {
      cb(event)
    }

    ipcRenderer.on('agent:event', handler)

    return () => {
      ipcRenderer.removeListener('agent:event', handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
