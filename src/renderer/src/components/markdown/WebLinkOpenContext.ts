import { createContext } from 'react'

/** Lets embedded Markdown use the workspace's in-app browser without prop drilling through cells. */
export const WebLinkOpenContext = createContext<((url: string) => void) | null>(null)
