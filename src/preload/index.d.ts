declare global {
  interface Window {
    api: {
      sendPrompt: (text: string) => Promise<void>
      onAgentEvent: (cb: (event: Record<string, unknown>) => void) => () => void
    }
  }
}
