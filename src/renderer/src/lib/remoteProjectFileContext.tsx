import { createContext, useContext } from 'react'

export interface RemoteProjectFileContextValue {
  hostAlias: string
  canonicalRoot: string
  openPath: (uri: string, kind: 'file' | 'directory') => void
}

export const RemoteProjectFileContext = createContext<RemoteProjectFileContextValue | null>(null)

export function useRemoteProjectFileContext(): RemoteProjectFileContextValue | null {
  return useContext(RemoteProjectFileContext)
}
