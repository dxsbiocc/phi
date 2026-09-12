import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'

const htmlFrameMessageSource = 'phi:notebook-html-output'

function htmlFrameResizeScript(frameId: string): string {
  return `<script>
(() => {
  const frameId = ${JSON.stringify(frameId)};
  const sendHeight = () => {
    const body = document.body;
    const root = document.documentElement;
    const height = Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0
    ));
    parent.postMessage({ source: ${JSON.stringify(htmlFrameMessageSource)}, frameId, height }, '*');
  };
  const scheduleHeight = () => requestAnimationFrame(sendHeight);
  window.addEventListener('load', scheduleHeight);
  if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleHeight).observe(document.documentElement);
  } else {
    setInterval(scheduleHeight, 500);
  }
  scheduleHeight();
})();
</script>`
}

function notebookOutputBaseHref(notebookPath?: string | null): string | undefined {
  if (!notebookPath) return undefined
  const normalizedPath = notebookPath.replace(/\\/g, '/')
  const lastSlashIndex = normalizedPath.lastIndexOf('/')
  if (lastSlashIndex < 0) return undefined
  const directory = normalizedPath.slice(0, lastSlashIndex + 1)
  if (!directory || (!directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory))) {
    return undefined
  }

  const encodedPath = directory
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return directory.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`
}

function htmlFrameHeadContent(baseHref?: string): string {
  const baseHrefAttribute = baseHref ? ` href="${baseHref}"` : ''
  return `<base${baseHrefAttribute} target="_blank">
  <style>
    html, body { margin: 0; background: transparent; color: inherit; }
    body { font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
    img, svg, canvas, iframe { max-width: 100%; }
    iframe { border: 0; }
  </style>`
}

function injectBeforeClosingTag(html: string, tag: 'head' | 'body', content: string): string {
  const closingTag = new RegExp(`</${tag}>`, 'i')
  if (closingTag.test(html)) {
    return html.replace(closingTag, `${content}</${tag}>`)
  }
  return `${content}${html}`
}

function htmlDocument(html: string, frameId: string, baseHref?: string): string {
  const resizeScript = htmlFrameResizeScript(frameId)
  if (/<html[\s>]/i.test(html)) {
    const withHead = injectBeforeClosingTag(html, 'head', htmlFrameHeadContent(baseHref))
    return injectBeforeClosingTag(withHead, 'body', resizeScript)
  }

  return `<!doctype html>
<html>
<head>
  ${htmlFrameHeadContent(baseHref)}
</head>
<body>${html}${resizeScript}</body>
</html>`
}

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

function escapeScriptText(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script')
}

function javascriptElementBridge(): string {
  return `(() => {
  const outputElement = document.getElementById('phi-js-output');
  const toNode = (value) => {
    if (typeof value !== 'string') return value;
    const template = document.createElement('template');
    template.innerHTML = value;
    return template.content;
  };
  const element = [outputElement];
  element.get = (index = 0) => (index === 0 ? outputElement : undefined);
  element.empty = () => {
    outputElement.replaceChildren();
    return element;
  };
  element.append = (...items) => {
    outputElement.append(...items.map(toNode));
    return element;
  };
  element.html = (value) => {
    if (value === undefined) return outputElement.innerHTML;
    outputElement.innerHTML = value;
    return element;
  };
  element.text = (value) => {
    if (value === undefined) return outputElement.textContent;
    outputElement.textContent = value;
    return element;
  };
  window.outputElement = outputElement;
  window.element = element;
})();`
}

function javascriptDocument(script: string, frameId: string, baseHref?: string): string {
  return htmlDocument(
    `<div id="phi-js-output"></div><script>${javascriptElementBridge()}
${escapeScriptText(script)}</script>`,
    frameId,
    baseHref
  )
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
  const baseHref = useMemo(() => notebookOutputBaseHref(notebookPath), [notebookPath])
  const srcDoc = useMemo(
    () =>
      frameKind === 'javascript'
        ? javascriptDocument(html, frameId, baseHref)
        : htmlDocument(html, frameId, baseHref),
    [baseHref, frameId, frameKind, html]
  )

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
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
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
