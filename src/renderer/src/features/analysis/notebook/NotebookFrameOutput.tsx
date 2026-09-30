import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'
import {
  notebookOutputBaseHref,
  notebookOutputFrameDocument
} from '../lib/notebookOutputFrameDocument'

const htmlFrameMessageSource = 'phi:notebook-html-output'

function isHtmlFrameMessageData(
  value: unknown
): value is { source: typeof htmlFrameMessageSource; frameId: string; height: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { source?: unknown }).source === htmlFrameMessageSource &&
    typeof (value as { frameId?: unknown }).frameId === 'string' &&
    typeof (value as { height?: unknown }).height === 'number'
  )
}

type NotebookOutputFrameApi = {
  publishNotebookOutputFrame?: (html: string) => Promise<string>
  releaseNotebookOutputFrame?: (url: string) => Promise<void>
}

function notebookOutputFrameApi(): NotebookOutputFrameApi | null {
  const api = (window as unknown as { api?: NotebookOutputFrameApi }).api
  if (!api?.publishNotebookOutputFrame || !api.releaseNotebookOutputFrame) return null
  return api
}

export default function NotebookHtmlFrameOutput({
  html,
  mime = 'text/html',
  frameKind = 'html',
  notebookPath,
  title = 'Notebook HTML output'
}: {
  html: string
  mime?: string
  frameKind?: 'html' | 'javascript'
  notebookPath?: string | null
  title?: string
}): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameId = useId()
  const [height, setHeight] = useState(220)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const baseHref = useMemo(() => notebookOutputBaseHref(notebookPath), [notebookPath])
  const srcDoc = useMemo(
    () => notebookOutputFrameDocument({ html, frameId, frameKind, notebookPath }),
    [frameId, frameKind, html, notebookPath]
  )

  useEffect(() => {
    const api = notebookOutputFrameApi()
    if (!api?.publishNotebookOutputFrame || !api.releaseNotebookOutputFrame) return undefined

    let cancelled = false
    let publishedUrl: string | null = null
    void api.publishNotebookOutputFrame(srcDoc).then((url) => {
      if (cancelled) {
        void api.releaseNotebookOutputFrame?.(url)
        return
      }
      publishedUrl = url
      setFrameUrl(url)
    })

    return () => {
      cancelled = true
      setFrameUrl(null)
      if (publishedUrl) void api.releaseNotebookOutputFrame?.(publishedUrl)
    }
  }, [srcDoc])

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (!isHtmlFrameMessageData(event.data)) return
      if (event.data.frameId !== frameId) return
      if (frameRef.current?.contentWindow && event.source !== frameRef.current.contentWindow) return
      const nextHeight = Math.min(Math.max(Math.ceil(event.data.height), 80), 2400)
      setHeight((currentHeight) =>
        Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
      )
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameId])

  return (
    <Box
      ref={frameRef}
      component="iframe"
      data-phi-notebook-output-kind={mime}
      data-phi-notebook-output-html-frame={frameKind === 'html' ? 'true' : undefined}
      data-phi-notebook-output-javascript-frame={frameKind === 'javascript' ? 'true' : undefined}
      data-phi-notebook-output-html-autoheight="true"
      data-phi-notebook-output-base-href={baseHref}
      title={title}
      // phi-output is a separate origin from the app. allow-same-origin keeps
      // that origin so charts can run scripts and load CDN libraries; it does
      // not grant access to the Phi window.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      src={frameUrl ?? undefined}
      srcDoc={frameUrl ? undefined : srcDoc}
      sx={{
        display: 'block',
        width: '100%',
        height,
        minHeight: 80,
        border: 0,
        bgcolor: 'transparent'
      }}
    />
  )
}
