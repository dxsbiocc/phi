export const MAX_PRESENTED_FILES = 4

export type PresentedOfficeKind = 'xlsx' | 'docx' | 'pptx'

export interface PresentedOfficeFile {
  artifactId: string
  outputId: string
  kind: PresentedOfficeKind
  revision: number
  sha256: string
  warnings: string[]
  checks: {
    schema: 'passed'
    content: 'passed'
    samples: number
    pageCount?: number
  }
}

export interface PresentedFile {
  path: string
  displayPath: string
  bytes: number
  description?: string
  artifact?: {
    kind: string
    title: string
    envId?: string
  }
  office?: PresentedOfficeFile
}
