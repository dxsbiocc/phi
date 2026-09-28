export const MAX_PRESENTED_FILES = 4

export interface PresentedFile {
  path: string
  displayPath: string
  bytes: number
  description?: string
}
