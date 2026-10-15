import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import type { AnalysisNotebookFile } from '../../../types'
import {
  createNotebookAutosave,
  type NotebookAutosave,
  type NotebookSaveState,
  type NotebookSaveResult
} from '../lib/notebookAutosave'

const unavailableSave = (): false => false

export function useNotebookAutosave({
  file,
  document,
  onSave,
  enabled = true
}: {
  file?: AnalysisNotebookFile | null
  document: NotebookDocument | null
  onSave?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument
  ) => NotebookSaveResult | Promise<NotebookSaveResult>
  enabled?: boolean
}): { autosave: NotebookAutosave; saveState: NotebookSaveState; saveError: string | undefined } {
  const [autosave] = useState(() => createNotebookAutosave({ save: onSave ?? unavailableSave }))
  useSyncExternalStore(autosave.subscribe, autosave.snapshot, autosave.snapshot)
  useLayoutEffect(() => {
    autosave.setSaveHandler(onSave ?? unavailableSave)
  }, [autosave, onSave])
  useLayoutEffect(() => {
    if (file && document && onSave && enabled) autosave.observe(file, document)
  }, [autosave, document, enabled, file, onSave])
  useLayoutEffect(() => {
    const path = file?.path
    return () => {
      if (path) autosave.flush(path)
    }
  }, [autosave, file?.path])
  return { autosave, saveState: autosave.state(file?.path), saveError: autosave.error(file?.path) }
}
