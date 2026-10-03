import { useEffect, useMemo, useRef, useState, type MouseEventHandler, type ReactNode } from 'react'
import { Box, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { GoCircleSlash, GoDownload, GoEye, GoSync, GoZoomIn, GoZoomOut } from 'react-icons/go'
import { changeset, type View } from 'vega'
import type { EmbedOptions, VisualizationSpec } from 'vega-embed'
import { Handler } from 'vega-tooltip'
import type { JsonObject } from '../../../../../shared/notebookDocument'
import NotebookPreOutput from './NotebookPreOutput'
import {
  isJsonObject,
  type NotebookMimeMetadata,
  prettyJson,
  vegaMode,
  zoomNumericDomain
} from './notebookOutputUtils'

function containerWidth(spec: JsonObject): JsonObject[string] | undefined {
  if (spec.width !== undefined) return spec.width
  return isJsonObject(spec.spec) ? containerWidth(spec.spec) : undefined
}

function usesContainerWidth(spec: JsonObject): boolean {
  return containerWidth(spec) === 'container'
}

const zoomInFactor = 1 / 1.4
const zoomOutFactor = 1.4

function numericDomain(domain: unknown): number[] {
  if (!Array.isArray(domain)) return []
  return domain.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

function selectionPrefix(view: View): string | null {
  const signals = view.getState().signals ?? {}
  const name = Object.keys(signals).find((item) => item.endsWith('_tuple_fields'))
  return name ? name.slice(0, -'_tuple_fields'.length) : null
}

function zoomChartView(view: View, factor: number): void {
  const xScale = view.scale('x') as { domain?: () => unknown } | null
  const yScale = view.scale('y') as { domain?: () => unknown } | null
  const xNext = zoomNumericDomain(numericDomain(xScale?.domain?.()), factor)
  const yNext = zoomNumericDomain(numericDomain(yScale?.domain?.()), factor)
  if (!xNext && !yNext) return

  const prefix = selectionPrefix(view)
  if (prefix && xNext && yNext) {
    const fields = view.signal(`${prefix}_tuple_fields`)
    const store = `${prefix}_store`
    const existing = view.data(store)
    let change = changeset()
    if (Array.isArray(existing)) {
      for (const row of existing) change = change.remove(row)
    }
    view.change(store, change.insert({ unit: '', fields, values: [xNext, yNext] }))
    view.signal(`${prefix}_x`, xNext)
    view.signal(`${prefix}_y`, yNext)
  } else {
    const xMutable = xScale as { domain: (value?: unknown) => unknown } | null
    const yMutable = yScale as { domain: (value?: unknown) => unknown } | null
    if (xNext && xMutable?.domain) xMutable.domain(xNext)
    if (yNext && yMutable?.domain) yMutable.domain(yNext)
  }
  void view.runAsync()
}

function ChartModeButton({
  label,
  disabled,
  menu,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  menu?: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip title={label} enterDelay={300}>
      <span>
        <IconButton
          type="button"
          size="small"
          disabled={disabled}
          aria-label={label}
          aria-haspopup={menu ? 'menu' : undefined}
          data-phi-notebook-output-vega-action={label}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={onClick}
          sx={{
            width: 32,
            height: 32,
            p: 0,
            borderRadius: 0.75,
            color: 'text.secondary',
            bgcolor: 'transparent',
            '&:hover': {
              bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08)
            }
          }}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  )
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
  const viewRef = useRef<View | null>(null)
  const initialStateRef = useRef<ReturnType<View['getState']> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRendering, setIsRendering] = useState(true)
  const [downloadAnchorEl, setDownloadAnchorEl] = useState<HTMLButtonElement | null>(null)
  const [viewReady, setViewReady] = useState(false)
  const [tooltipEnabled, setTooltipEnabled] = useState(true)
  const downloadMenuOpen = downloadAnchorEl !== null
  const theme = useTheme()
  const specText = useMemo(() => prettyJson(spec), [spec])
  const shouldRemeasureContainer = useMemo(() => usesContainerWidth(spec), [spec])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let cancelled = false
    let finalize: (() => void) | undefined
    let resizeObserver: ResizeObserver | undefined
    viewRef.current = null
    initialStateRef.current = null
    setError(null)
    setIsRendering(true)
    setViewReady(false)

    void import('vega-embed')
      .then(async (module) => {
        if (cancelled) return
        const embed = module.default
        const embedOptions: EmbedOptions = {
          actions: false,
          mode: vegaMode(mime),
          renderer: 'canvas',
          tooltip: true,
          // The app page forbids eval. Vega's AST interpreter draws the chart
          // without compiling expressions through `new Function`.
          ast: true
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
        viewRef.current = result.view
        initialStateRef.current = result.view.getState()
        setTooltipEnabled(true)
        finalize = () => {
          resizeObserver?.disconnect()
          result.finalize()
        }
        setIsRendering(false)
        setViewReady(true)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setIsRendering(false)
        setError(cause instanceof Error ? cause.message : 'Unable to render Vega output')
      })

    return () => {
      cancelled = true
      viewRef.current = null
      initialStateRef.current = null
      resizeObserver?.disconnect()
      finalize?.()
    }
  }, [metadata?.height, metadata?.width, mime, shouldRemeasureContainer, spec, theme.palette.mode])

  function resetChartZoom(): void {
    const view = viewRef.current
    const initialState = initialStateRef.current
    if (!view || !initialState) return
    const width = view.width()
    const height = view.height()
    view.setState(initialState)
    view.width(width).height(height).resize()
    void view.runAsync()
  }

  function zoomChart(factor: number): void {
    const view = viewRef.current
    if (!view) return
    zoomChartView(view, factor)
  }

  function toggleChartTooltip(): void {
    const view = viewRef.current
    if (!view) return
    const next = !tooltipEnabled
    setTooltipEnabled(next)
    view.tooltip(next ? new Handler().call : () => undefined)
  }

  function exportChart(format: 'png' | 'svg'): void {
    setDownloadAnchorEl(null)
    const view = viewRef.current
    if (!view) return
    void view
      .toImageURL(format, format === 'png' ? 2 : 1)
      .then((url) => {
        const link = document.createElement('a')
        link.href = url
        link.download = `notebook-chart.${format}`
        document.body.appendChild(link)
        link.click()
        link.remove()
      })
      .catch((cause: unknown) => {
        console.error('Failed to export notebook chart:', cause)
      })
  }

  return (
    <Box
      data-phi-notebook-output-kind={mime}
      data-phi-notebook-output-vega="true"
      data-phi-notebook-output-width={metadata?.width}
      data-phi-notebook-output-height={metadata?.height}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        bgcolor: 'transparent',
        '&:hover .notebook-output-hover-actions, &:focus-within .notebook-output-hover-actions': {
          opacity: 1,
          pointerEvents: 'auto'
        }
      }}
    >
      <Box
        data-phi-notebook-output-vega-toolbar="true"
        className="notebook-output-hover-actions"
        sx={{
          alignItems: 'center',
          display: 'flex',
          gap: 0,
          position: 'absolute',
          top: 6,
          right: 6,
          zIndex: 2,
          opacity: downloadMenuOpen ? 1 : 0,
          pointerEvents: downloadMenuOpen ? 'auto' : 'none',
          transition: 'opacity 140ms ease',
          px: 0.25,
          py: 0.25,
          borderRadius: 1,
          bgcolor: (paletteTheme) => alpha(paletteTheme.palette.background.paper, 0.94)
        }}
      >
        <ChartModeButton
          label="下载图片"
          disabled={!viewReady}
          menu
          onClick={(event) => setDownloadAnchorEl(event.currentTarget)}
        >
          <GoDownload size={20} />
        </ChartModeButton>
        <Menu
          anchorEl={downloadAnchorEl}
          open={downloadMenuOpen}
          onClose={() => setDownloadAnchorEl(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem onClick={() => exportChart('png')}>PNG</MenuItem>
          <MenuItem onClick={() => exportChart('svg')}>SVG</MenuItem>
        </Menu>
        <ChartModeButton label="放大" disabled={!viewReady} onClick={() => zoomChart(zoomInFactor)}>
          <GoZoomIn size={20} />
        </ChartModeButton>
        <ChartModeButton
          label="缩小"
          disabled={!viewReady}
          onClick={() => zoomChart(zoomOutFactor)}
        >
          <GoZoomOut size={20} />
        </ChartModeButton>
        <ChartModeButton label="重置坐标" disabled={!viewReady} onClick={resetChartZoom}>
          <GoSync size={20} />
        </ChartModeButton>
        <ChartModeButton
          label={tooltipEnabled ? '关闭悬停提示' : '显示悬停提示'}
          disabled={!viewReady}
          onClick={toggleChartTooltip}
        >
          {tooltipEnabled ? <GoCircleSlash size={20} /> : <GoEye size={20} />}
        </ChartModeButton>
      </Box>
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
            minHeight: 236
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
