import { createContext, type ReactNode } from 'react'

export const MarkdownCodeActionsContext = createContext<
  ((language: string, source: string) => ReactNode) | null
>(null)
