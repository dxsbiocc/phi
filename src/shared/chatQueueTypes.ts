import type { PromptImageInput } from './promptImageTypes'

export interface ChatQueueTarget {
  path: string | null
  phiSessionId?: string
  draftId?: string
  cwd: string
  sessionGeneration?: number
  images?: PromptImageInput[]
  retryUserMessageId?: string
  planMode?: boolean
  planExecute?: boolean
}

export interface ChatQueueReceipt {
  id: string
  sessionId: string
  path: string
  sessionGeneration: number
}

export interface ChatQueueItem {
  id: string
  text: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  imageCount: number
}
