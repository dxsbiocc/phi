import { chatCopy } from '../lib/chatCopy'
import { useCallback, useState, type ClipboardEvent } from 'react'

import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  type PromptImageInput,
  type PromptImageMimeType
} from '../../../../../shared/promptImageTypes'

function readClipboardImage(file: File): Promise<PromptImageInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(chatCopy.unableToReadClipboardImage))
    reader.onload = () => {
      const value = reader.result
      const match =
        typeof value === 'string'
          ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(value)
          : null
      if (!match) {
        reject(new Error(chatCopy.unsupportedClipboardImageFormat))
        return
      }
      resolve({ mimeType: match[1] as PromptImageMimeType, data: match[2] })
    }
    reader.readAsDataURL(file)
  })
}

export function usePastedImages(input: {
  images: PromptImageInput[]
  supportsImages?: boolean
  onImagesAdded?: (images: PromptImageInput[]) => void
}): {
  pasteError: string | null
  isReading: boolean
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
} {
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [isReading, setIsReading] = useState(false)
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length === 0) return
      event.preventDefault()
      setPasteError(null)
      if (input.supportsImages === false) {
        setPasteError(chatCopy.theCurrentModelDoesNotSupportImagesChooseAnotherModel)
        return
      }
      if (input.images.length + files.length > MAX_PROMPT_IMAGES) {
        setPasteError(chatCopy.pasteUpToValueImagesAtATime(MAX_PROMPT_IMAGES))
        return
      }
      if (files.some((file) => file.size === 0 || file.size > MAX_PROMPT_IMAGE_BYTES)) {
        setPasteError(chatCopy.eachImageMustBeSmallerThan8MB)
        return
      }
      setIsReading(true)
      void Promise.all(files.map(readClipboardImage))
        .then((images) => input.onImagesAdded?.(images))
        .catch((error: unknown) =>
          setPasteError(
            error instanceof Error ? error.message : chatCopy.unableToReadClipboardImage
          )
        )
        .finally(() => setIsReading(false))
    },
    [input]
  )
  return { pasteError, isReading, onPaste }
}
