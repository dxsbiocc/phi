import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

import { updateNotebookCell, type NotebookDocument } from '../../../../../shared/notebookDocument'
import type { AnalysisNotebookCompletionResult, AnalysisNotebookFile } from '../../../types'
import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import type { NotebookCanvasProps } from '../lib/notebookCanvasTypes'
import { notebookSyntaxLanguage } from '../lib/notebookViewModel'

type NotebookSourceServicesOptions = {
  notebookFile?: AnalysisNotebookFile | null
  draftDocument: NotebookDocument | null
  setDraftDocument: Dispatch<SetStateAction<NotebookDocument | null>>
  onCompleteNotebookCell?: NotebookCanvasProps['onCompleteNotebookCell']
  onFormatNotebookCell?: NotebookCanvasProps['onFormatNotebookCell']
}

export type NotebookSourceServices = {
  canUseCompletionProvider: boolean
  formattingError: string | null
  isFormattingNotebook: boolean
  onCompleteCellSource: (
    cellId: string,
    source: string,
    cursorPosition: number
  ) => Promise<AnalysisNotebookCompletionResult | null>
  onFormatCellSource: (cellId: string, source: string, language?: SyntaxLanguage) => Promise<void>
  onFormatNotebook: () => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function useNotebookSourceServices({
  notebookFile,
  draftDocument,
  setDraftDocument,
  onCompleteNotebookCell,
  onFormatNotebookCell
}: NotebookSourceServicesOptions): NotebookSourceServices {
  const [formattingError, setFormattingError] = useState<string | null>(null)
  const [isFormattingNotebook, setIsFormattingNotebook] = useState(false)
  const canUseCompletionProvider = Boolean(notebookFile && draftDocument && onCompleteNotebookCell)

  const onCompleteCellSource = useCallback(
    async (
      cellId: string,
      source: string,
      cursorPosition: number
    ): Promise<AnalysisNotebookCompletionResult | null> => {
      if (!notebookFile || !draftDocument || !onCompleteNotebookCell) {
        return null
      }
      return onCompleteNotebookCell(notebookFile, draftDocument, cellId, source, cursorPosition)
    },
    [draftDocument, notebookFile, onCompleteNotebookCell]
  )

  const onFormatCellSource = useCallback(
    async (cellId: string, source: string, language?: SyntaxLanguage): Promise<void> => {
      if (!notebookFile || !draftDocument || !onFormatNotebookCell) return
      setFormattingError(null)
      try {
        const result = await onFormatNotebookCell(
          notebookFile,
          draftDocument,
          cellId,
          source,
          language
        )
        if (result.message && result.formatter === 'none') {
          setFormattingError(result.message)
        }
        if (!result.changed) return
        setDraftDocument((document) =>
          document ? updateNotebookCell(document, cellId, { source: result.source }) : document
        )
      } catch (error) {
        setFormattingError(errorMessage(error))
      }
    },
    [draftDocument, notebookFile, onFormatNotebookCell, setDraftDocument]
  )

  const onFormatNotebook = useCallback(async (): Promise<void> => {
    if (!draftDocument || !notebookFile || !onFormatNotebookCell || isFormattingNotebook) return
    setIsFormattingNotebook(true)
    setFormattingError(null)
    try {
      let nextDocument = draftDocument
      let lastMessage: string | undefined
      const language = notebookSyntaxLanguage(draftDocument)
      for (const cell of draftDocument.cells) {
        if (cell.cellType !== 'code') continue
        const result = await onFormatNotebookCell(
          notebookFile,
          nextDocument,
          cell.id,
          cell.source,
          language
        )
        if (result.message && result.formatter === 'none') {
          lastMessage = result.message
        }
        if (result.changed) {
          nextDocument = updateNotebookCell(nextDocument, cell.id, { source: result.source })
        }
      }
      if (nextDocument !== draftDocument) {
        setDraftDocument(nextDocument)
      } else if (lastMessage) {
        setFormattingError(lastMessage)
      }
    } catch (error) {
      setFormattingError(errorMessage(error))
    } finally {
      setIsFormattingNotebook(false)
    }
  }, [draftDocument, isFormattingNotebook, notebookFile, onFormatNotebookCell, setDraftDocument])

  return {
    canUseCompletionProvider,
    formattingError,
    isFormattingNotebook,
    onCompleteCellSource,
    onFormatCellSource,
    onFormatNotebook
  }
}
