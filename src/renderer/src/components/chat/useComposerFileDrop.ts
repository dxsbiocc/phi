import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import {
  formatInputFileReferences,
  inputFileReferencePathsFromDroppedFiles
} from '../../lib/inputReferences'

type ComposerFileDropHandlers = {
  onDragEnter: (event: DragEvent<HTMLElement>) => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
}

export type ComposerFileDropState = {
  isDragActive: boolean
  dragHandlers: ComposerFileDropHandlers
}

export function useComposerFileDrop({
  cwd,
  onGetPathForFile,
  onInputFilesDropped,
  onInsertReference
}: {
  cwd: string
  onGetPathForFile?: (file: File) => string
  onInputFilesDropped?: (cb: (paths: string[]) => void) => () => void
  onInsertReference: (reference: string) => void
}): ComposerFileDropState {
  const [isDragActive, setIsDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  const resetDragState = useCallback((): void => {
    dragDepthRef.current = 0
    setIsDragActive(false)
  }, [])

  const insertDroppedFileReferences = useCallback(
    (files: File[]): void => {
      const paths = inputFileReferencePathsFromDroppedFiles(files, onGetPathForFile)
      const reference = formatInputFileReferences(paths, cwd)
      if (reference) {
        onInsertReference(reference)
      }
    },
    [cwd, onGetPathForFile, onInsertReference]
  )
  const insertDroppedFilePaths = useCallback(
    (paths: string[]): void => {
      const reference = formatInputFileReferences(paths, cwd)
      if (reference) {
        onInsertReference(reference)
      }
    },
    [cwd, onInsertReference]
  )

  useEffect(() => {
    if (!onInputFilesDropped) return undefined

    return onInputFilesDropped((paths) => {
      if (paths.length === 0) return
      resetDragState()
      insertDroppedFilePaths(paths)
    })
  }, [insertDroppedFilePaths, onInputFilesDropped, resetDragState])

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    dragDepthRef.current += 1
    setIsDragActive(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setIsDragActive(true)
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragActive(false)
    }
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      const files = Array.from(event.dataTransfer.files)
      resetDragState()
      insertDroppedFileReferences(files)
    },
    [insertDroppedFileReferences, resetDragState]
  )

  return {
    isDragActive,
    dragHandlers: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop
    }
  }
}

function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  if (types.includes('Files')) return true
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}
