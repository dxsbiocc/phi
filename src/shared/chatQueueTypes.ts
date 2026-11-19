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

export type ChatQueueJobStatus = ChatQueueItem['status']

export interface ChatQueueJob {
  id: string
  sessionId: string
  sessionPath: string
  title?: string
  preview: string
  status: ChatQueueJobStatus
  result?: string
  independent?: true
  imageCount: number
  timestamp: string
}

export interface ChatQueueJobsVersion {
  epoch: string
  revision: number
}

export interface ChatQueueJobsSnapshot extends ChatQueueJobsVersion {
  items: readonly ChatQueueJob[]
}
