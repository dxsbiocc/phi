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
    reader.onerror = () => reject(new Error('无法读取剪贴板图片'))
    reader.onload = () => {
      const value = reader.result
      const match =
        typeof value === 'string'
          ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(value)
          : null
      if (!match) {
        reject(new Error('不支持的剪贴板图片格式'))
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
        setPasteError('当前模型不支持图片，请先切换模型')
        return
      }
      if (input.images.length + files.length > MAX_PROMPT_IMAGES) {
        setPasteError(`一次最多粘贴 ${MAX_PROMPT_IMAGES} 张图片`)
        return
      }
      if (files.some((file) => file.size === 0 || file.size > MAX_PROMPT_IMAGE_BYTES)) {
        setPasteError('每张图片必须小于 8 MB')
        return
      }
      setIsReading(true)
      void Promise.all(files.map(readClipboardImage))
        .then((images) => input.onImagesAdded?.(images))
        .catch((error: unknown) =>
          setPasteError(error instanceof Error ? error.message : '无法读取剪贴板图片')
        )
        .finally(() => setIsReading(false))
    },
    [input]
  )
  return { pasteError, isReading, onPaste }
}
