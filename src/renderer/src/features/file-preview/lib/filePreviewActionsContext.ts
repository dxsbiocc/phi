import { createContext } from 'react'

export const FilePreviewActionsContext = createContext<{
  target: HTMLDivElement | null
  inHeader: boolean
}>({ target: null, inHeader: false })
