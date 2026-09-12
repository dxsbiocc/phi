import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import type { EmbedOptions, VisualizationSpec } from 'vega-embed'
import type { JsonObject } from '../../../../../shared/notebookDocument'
import NotebookPreOutput from './NotebookPreOutput'
import {
  isJsonObject,
  type NotebookMimeMetadata,
  prettyJson,
  vegaMode
} from './notebookOutputUtils'

function containerWidth(spec: JsonObject): JsonObject[string] | undefined {
  if (spec.width !== undefined) return spec.width
  return isJsonObject(spec.spec) ? containerWidth(spec.spec) : undefined
}

function usesContainerWidth(spec: JsonObject): boolean {
  return containerWidth(spec) === 'container'
}

export function NotebookVegaOutput({
  mime,
  metadata,
  spec
}: {
  mime: string
  metadata?: NotebookMimeMetadata
  spec: JsonObject
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRendering, setIsRendering] = useState(true)
  const theme = useTheme()
  const specText = useMemo(() => prettyJson(spec), [spec])
  const shouldRemeasureContainer = useMemo(() => usesContainerWidth(spec), [spec])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let cancelled = false
    let finalize: (() => void) | undefined
    let resizeObserver: ResizeObserver | undefined
    setError(null)
    setIsRendering(true)

    void import('vega-embed')
      .then(async (module) => {
        if (cancelled) return
        const embed = module.default
        const embedOptions: EmbedOptions = {
          actions: false,
          mode: vegaMode(mime),
          renderer: 'canvas',
          tooltip: true
        }
        if (theme.palette.mode === 'dark') {
          embedOptions.theme = 'dark'
        }
        if (metadata?.width) {
          embedOptions.width = metadata.width
        }
        if (metadata?.height) {
          embedOptions.height = metadata.height
        }
        const result = await embed(container, spec as unknown as VisualizationSpec, embedOptions)
        if (cancelled) {
          result.finalize()
          return
        }
        if (shouldRemeasureContainer && typeof ResizeObserver !== 'undefined') {
          let lastWidth = container.clientWidth
          resizeObserver = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? 0
            if (width <= 0) {
              lastWidth = 0
              return
            }
            if (Math.round(width) === Math.round(lastWidth)) return
            lastWidth = width
            window.requestAnimationFrame(() => {
              window.dispatchEvent(new Event('resize'))
              void result.view.resize().runAsync()
            })
          })
          resizeObserver.observe(container)
        }
        finalize = () => {
          resizeObserver?.disconnect()
          result.finalize()
        }
        setIsRendering(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setIsRendering(false)
        setError(cause instanceof Error ? cause.message : 'Unable to render Vega output')
      })

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      finalize?.()
    }
  }, [metadata?.height, metadata?.width, mime, shouldRemeasureContainer, spec, theme.palette.mode])

  return (
    <Box
      data-phi-notebook-output-kind={mime}
      data-phi-notebook-output-vega="true"
      data-phi-notebook-output-width={metadata?.width}
      data-phi-notebook-output-height={metadata?.height}
      sx={{
        border: 1,
        borderColor: (paletteTheme) => alpha(paletteTheme.palette.text.primary, 0.1),
        borderRadius: 1.25,
        overflow: 'hidden',
        bgcolor: 'background.paper'
      }}
    >
      <Box
        sx={{
          minHeight: 260,
          overflow: 'auto',
          p: 1.25,
          position: 'relative'
        }}
      >
        <Box
          ref={containerRef}
          data-phi-notebook-output-vega-canvas="true"
          data-phi-notebook-output-vega-container-width={
            shouldRemeasureContainer ? 'true' : undefined
          }
          sx={{
            minHeight: 236,
            '& canvas, & svg': {
              maxWidth: '100%'
            }
          }}
        />
        {isRendering && !error ? (
          <Box
            data-phi-notebook-output-vega-loading="true"
            sx={{
              alignItems: 'center',
              display: 'flex',
              inset: 0,
              justifyContent: 'center',
              pointerEvents: 'none',
              position: 'absolute'
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Rendering Vega-Lite output...
            </Typography>
          </Box>
        ) : null}
      </Box>
      {error ? (
        <Box
          data-phi-notebook-output-vega-error="true"
          sx={{
            borderTop: 1,
            borderColor: (paletteTheme) => alpha(paletteTheme.palette.error.main, 0.18),
            p: 1.25
          }}
        >
          <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 700 }}>
            Vega render failed
          </Typography>
          <NotebookPreOutput kind={`${mime}:fallback`} text={specText} tone="error" />
        </Box>
      ) : null}
    </Box>
  )
}

export function NotebookPlotlyOutput({
  metadata,
  spec
}: {
  metadata?: NotebookMimeMetadata
  spec: JsonObject
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const specText = useMemo(() => prettyJson(spec), [spec])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let cancelled = false
    let plotlyModule: { purge?: (element: HTMLElement) => void } | undefined
    setError(null)

    void import('plotly.js-dist-min')
      .then(async (module) => {
        if (cancelled) return
        const plotly = module.default
        plotlyModule = plotly
        const data = Array.isArray(spec.data) ? spec.data : []
        const layout = isJsonObject(spec.layout) ? spec.layout : {}
        const config = isJsonObject(spec.config) ? spec.config : {}
        const frames = Array.isArray(spec.frames) ? spec.frames : undefined
        const sizedLayout = {
          ...layout,
          ...(metadata?.width && layout.width === undefined ? { width: metadata.width } : {}),
          ...(metadata?.height && layout.height === undefined ? { height: metadata.height } : {})
        }

        await plotly.react(container, data, sizedLayout, {
          displaylogo: false,
          responsive: true,
          ...config
        })
        if (cancelled) {
          plotly.purge(container)
          return
        }
        if (frames) {
          await plotly.addFrames(container, frames)
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Unable to render Plotly output')
      })

    return () => {
      cancelled = true
      if (container) {
        plotlyModule?.purge?.(container)
      }
    }
  }, [metadata?.height, metadata?.width, spec])

  return (
    <Box
      data-phi-notebook-output-kind="application/vnd.plotly.v1+json"
      data-phi-notebook-output-plotly="true"
      data-phi-notebook-output-width={metadata?.width}
      data-phi-notebook-output-height={metadata?.height}
      sx={{
        border: 1,
        borderColor: (paletteTheme) => alpha(paletteTheme.palette.text.primary, 0.1),
        borderRadius: 1.25,
        overflow: 'hidden',
        bgcolor: 'background.paper'
      }}
    >
      <Box
        ref={containerRef}
        data-phi-notebook-output-plotly-canvas="true"
        sx={{
          minHeight: 260,
          overflow: 'auto',
          p: 1.25
        }}
      />
      {error ? (
        <Box
          data-phi-notebook-output-plotly-error="true"
          sx={{
            borderTop: 1,
            borderColor: (paletteTheme) => alpha(paletteTheme.palette.error.main, 0.18),
            p: 1.25
          }}
        >
          <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 700 }}>
            Plotly render failed
          </Typography>
          <NotebookPreOutput
            kind="application/vnd.plotly.v1+json:fallback"
            text={specText}
            tone="error"
          />
        </Box>
      ) : null}
    </Box>
  )
}
