import { useState } from 'react'
import { Box, Button } from '@mui/material'
import { alpha } from '@mui/material/styles'
import MarkdownContent from '../../../components/MarkdownContent'
import type { JsonObject, NotebookOutput } from '../../../../../shared/notebookDocument'
import NotebookHtmlFrameOutput from './NotebookFrameOutput'
import NotebookPreOutput from './NotebookPreOutput'
import { NotebookPlotlyOutput, NotebookVegaOutput } from './NotebookRichOutput'
import NotebookHtmlTableOutput from './NotebookTableOutput'
import {
  firstDisplayMime,
  displayMimes,
  extractVegaSpecFromHtml,
  hasHtmlTable,
  isImageMime,
  isJavaScriptMime,
  isJsonObject,
  isPlotlyMime,
  isVegaMime,
  isVideoMime,
  metadataForMime,
  normalizeLatexDelimiters,
  type NotebookMimeMetadata,
  prettyJson,
  textFromValue
} from './notebookOutputUtils'

function mimeLabel(mime: string): string {
  if (isPlotlyMime(mime)) return 'Plotly'
  if (isVegaMime(mime)) return mime.includes('lite') ? 'Vega-Lite' : 'Vega'
  if (mime === 'text/html') return 'HTML'
  if (mime === 'text/plain') return 'Plain text'
  if (mime === 'text/markdown') return 'Markdown'
  if (mime === 'application/json') return 'JSON'
  if (mime === 'application/pdf') return 'PDF'
  if (mime === 'application/javascript' || mime === 'text/javascript') return 'JavaScript'
  if (mime === 'text/csv') return 'CSV'
  if (mime === 'text/latex') return 'LaTeX'
  if (isVideoMime(mime)) return mime.slice('video/'.length).toUpperCase()
  if (mime.startsWith('image/')) return mime.slice('image/'.length).toUpperCase()
  return mime
}

function dataUrl(mime: string, payload: string): string {
  return payload.startsWith('data:') ? payload : `data:${mime};base64,${payload}`
}

function mediaSx(metadata?: NotebookMimeMetadata): Record<string, string | number> {
  return {
    display: 'block',
    maxWidth: '100%',
    width: metadata?.width ?? 'auto',
    height: metadata?.height ?? 'auto'
  }
}

function NotebookMimeOutput({
  metadata,
  mime,
  value,
  notebookPath
}: {
  metadata?: NotebookMimeMetadata
  mime: string
  value: JsonObject[string]
  notebookPath?: string | null
}): React.JSX.Element | null {
  if (isVegaMime(mime)) {
    return isJsonObject(value) ? (
      <NotebookVegaOutput metadata={metadata} mime={mime} spec={value} />
    ) : (
      <NotebookPreOutput kind={mime} text={prettyJson(value)} tone="error" />
    )
  }

  if (isPlotlyMime(mime)) {
    return isJsonObject(value) ? (
      <NotebookPlotlyOutput metadata={metadata} spec={value} />
    ) : (
      <NotebookPreOutput kind={mime} text={prettyJson(value)} tone="error" />
    )
  }

  if (mime === 'text/html') {
    const html = textFromValue(value)
    if (!html) return null
    if (hasHtmlTable(html)) {
      return <NotebookHtmlTableOutput html={html} notebookPath={notebookPath} />
    }
    const vegaSpec = extractVegaSpecFromHtml(html)
    if (vegaSpec) {
      return <NotebookVegaOutput metadata={metadata} mime={vegaSpec.mime} spec={vegaSpec.spec} />
    }
    return <NotebookHtmlFrameOutput html={html} notebookPath={notebookPath} />
  }

  if (isJavaScriptMime(mime)) {
    const script = textFromValue(value)
    if (!script) return null
    return (
      <NotebookHtmlFrameOutput
        html={script}
        mime={mime}
        frameKind="javascript"
        notebookPath={notebookPath}
        title="Notebook JavaScript output"
      />
    )
  }

  if (isImageMime(mime) && mime !== 'image/svg+xml') {
    const image = textFromValue(value)
    if (!image) return null
    return (
      <Box
        component="img"
        data-phi-notebook-output-kind={mime}
        data-phi-notebook-output-width={metadata?.width}
        data-phi-notebook-output-height={metadata?.height}
        alt="Notebook image output"
        src={dataUrl(mime, image)}
        sx={mediaSx(metadata)}
      />
    )
  }

  if (mime === 'image/svg+xml') {
    const svg = textFromValue(value)
    if (!svg) return null
    const src = svg.startsWith('data:')
      ? svg
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    return (
      <Box
        component="img"
        data-phi-notebook-output-kind="image/svg+xml"
        data-phi-notebook-output-width={metadata?.width}
        data-phi-notebook-output-height={metadata?.height}
        alt="Notebook SVG output"
        src={src}
        sx={mediaSx(metadata)}
      />
    )
  }

  if (isVideoMime(mime)) {
    const video = textFromValue(value)
    if (!video) return null
    return (
      <Box
        component="video"
        controls
        data-phi-notebook-output-kind={mime}
        data-phi-notebook-output-width={metadata?.width}
        data-phi-notebook-output-height={metadata?.height}
        src={dataUrl(mime, video)}
        sx={mediaSx(metadata)}
      />
    )
  }

  if (mime === 'application/pdf') {
    const pdf = textFromValue(value)
    if (!pdf) return null
    return (
      <Box
        component="iframe"
        data-phi-notebook-output-kind="application/pdf"
        data-phi-notebook-output-pdf="true"
        data-phi-notebook-output-width={metadata?.width}
        data-phi-notebook-output-height={metadata?.height}
        title="Notebook PDF output"
        src={`data:application/pdf;base64,${pdf}`}
        sx={{
          display: 'block',
          width: metadata?.width ?? '100%',
          maxWidth: '100%',
          height: metadata?.height ?? 520,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.25,
          bgcolor: 'background.paper'
        }}
      />
    )
  }

  if (mime === 'text/markdown') {
    const markdown = textFromValue(value)
    if (!markdown) return null
    return (
      <Box data-phi-notebook-output-kind="text/markdown">
        <MarkdownContent text={markdown} enableMath />
      </Box>
    )
  }

  if (mime === 'text/latex') {
    // Kernels (e.g. sympy's _repr_latex_) emit this as plain text/an array
    // of lines, not a JSON value -- prettyJson() previously JSON.stringify'd
    // arrays instead of joining them, and there was no math renderer at all
    // to turn the LaTeX source into an actual formula.
    const latex = textFromValue(value) ?? prettyJson(value)
    if (!latex.trim()) return null
    return (
      <Box data-phi-notebook-output-kind="text/latex">
        <MarkdownContent text={normalizeLatexDelimiters(latex)} enableMath />
      </Box>
    )
  }

  if (mime === 'application/json' || mime === 'text/csv') {
    return <NotebookPreOutput kind={mime} text={prettyJson(value)} />
  }

  const text = textFromValue(value)
  if (text) {
    return <NotebookPreOutput kind={mime} text={text} />
  }
  return value === undefined ? null : <NotebookPreOutput kind={mime} text={prettyJson(value)} />
}

function NotebookDisplayData({
  data,
  metadata,
  notebookPath
}: {
  data: JsonObject
  metadata: JsonObject
  notebookPath?: string | null
}): React.JSX.Element | null {
  const mimes = displayMimes(data)
  const [requestedMime, setRequestedMime] = useState<string | null>(null)
  const activeMime =
    requestedMime && mimes.includes(requestedMime) ? requestedMime : firstDisplayMime(data)
  if (!activeMime) return null

  if (mimes.length <= 1) {
    return (
      <NotebookMimeOutput
        metadata={metadataForMime({ data, metadata, mime: activeMime })}
        mime={activeMime}
        value={data[activeMime]}
        notebookPath={notebookPath}
      />
    )
  }

  return (
    <Box
      data-phi-notebook-output-mime-tabs="true"
      data-phi-notebook-output-active-mime={activeMime}
      sx={{
        display: 'grid',
        gap: 0.75
      }}
    >
      <Box
        role="tablist"
        aria-label="Notebook output MIME choices"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5
        }}
      >
        {mimes.map((mime) => {
          const isActive = mime === activeMime
          return (
            <Button
              key={mime}
              type="button"
              role="tab"
              aria-selected={isActive}
              size="small"
              variant="text"
              onClick={() => setRequestedMime(mime)}
              data-phi-notebook-output-mime-tab={mime}
              sx={{
                minWidth: 0,
                px: 0.75,
                py: 0.15,
                borderRadius: 1,
                color: isActive ? 'primary.main' : 'text.secondary',
                fontSize: '0.72rem',
                lineHeight: 1.5,
                textTransform: 'none',
                bgcolor: (theme) =>
                  isActive ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                '&:hover': {
                  bgcolor: (theme) => alpha(theme.palette.primary.main, isActive ? 0.12 : 0.06)
                }
              }}
            >
              {mimeLabel(mime)}
            </Button>
          )
        })}
      </Box>
      <Box>
        <NotebookMimeOutput
          metadata={metadataForMime({ data, metadata, mime: activeMime })}
          mime={activeMime}
          value={data[activeMime]}
          notebookPath={notebookPath}
        />
      </Box>
    </Box>
  )
}

function NotebookOutputItem({
  output,
  notebookPath
}: {
  output: NotebookOutput
  notebookPath?: string | null
}): React.JSX.Element | null {
  if (output.outputType === 'stream') {
    return output.text ? (
      <NotebookPreOutput kind={`stream:${output.name ?? 'stdout'}`} text={output.text} />
    ) : null
  }

  if (output.outputType === 'error') {
    const title = [output.ename, output.evalue].filter(Boolean).join(': ')
    const traceback = output.traceback?.join('\n')
    const text = [title, traceback].filter(Boolean).join('\n')
    return text ? <NotebookPreOutput kind="error" text={text} tone="error" /> : null
  }

  return (
    <NotebookDisplayData
      data={output.data}
      metadata={output.metadata}
      notebookPath={notebookPath}
    />
  )
}

export default function NotebookOutputArea({
  notebookPath,
  outputs
}: {
  notebookPath?: string | null
  outputs: NotebookOutput[]
}): React.JSX.Element | null {
  if (outputs.length === 0) return null

  return (
    <>
      <Box
        data-phi-notebook-output="area"
        sx={{
          width: '100%',
          maxWidth: 'inherit',
          p: 2,
          clear: 'both',
          display: 'flow-root',
          overflow: 'auto',
          borderTop: 1,
          borderColor: (theme) => alpha(theme.palette.text.primary, 0.08),
          bgcolor: 'transparent',
          '& + &': {
            borderTop: 1,
            borderColor: 'divider'
          }
        }}
      >
        <Box>
          {outputs.map((output, index) => (
            <Box
              key={`${output.outputType}:${output.name ?? 'display'}:${index}`}
              sx={{ '& + &': { mt: 1 } }}
            >
              <NotebookOutputItem output={output} notebookPath={notebookPath} />
            </Box>
          ))}
        </Box>
      </Box>
    </>
  )
}
