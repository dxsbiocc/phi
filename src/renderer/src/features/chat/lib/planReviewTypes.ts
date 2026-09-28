import type { PresentedFile } from '../../../../../shared/presentedFileTypes'

export interface PresentedFilesItem {
  id: string
  role: 'presented_files'
  runId?: string
  createdAt?: string
  files: PresentedFile[]
}

export interface PlanReviewItem {
  id: string
  role: 'plan_review'
  reviewId: string
  runId?: string
  createdAt?: string
  title: string
  content: string
  planFilePath: string
  status: 'pending' | 'approved' | 'revise' | 'cancelled'
  note?: string
}
