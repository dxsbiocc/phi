import { Box, Tooltip } from '@mui/material'
import { useEffect, useState } from 'react'
import { HOVER_PREVIEW_OPEN_DELAY_MS } from '../../lib/markdownLocalPathPreview'
import { renderMoleculeSvg } from '../../lib/rdkitPreview'

type MoleculeRenderState = {
  value: string
  svg?: string
  error?: string
}

const MOLECULE_HOVER_PREVIEW_WIDTH = 260
const MOLECULE_HOVER_PREVIEW_HEIGHT = 180

const moleculeTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      maxWidth: 'none',
      p: 0.75
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': {
        border: '1px solid',
        borderColor: 'divider',
        boxSizing: 'border-box'
      }
    }
  }
} as const

function MoleculePreviewImage({
  smiles,
  width,
  height,
  shouldLoad
}: {
  smiles: string
  width: number
  height: number
  shouldLoad: boolean
}): React.JSX.Element {
  const [renderState, setRenderState] = useState<MoleculeRenderState | null>(null)
  const activeRenderState = renderState?.value === smiles ? renderState : null
  const svg = activeRenderState?.svg
  const error = activeRenderState?.error

  useEffect(() => {
    if (!shouldLoad) return

    let cancelled = false
    void renderMoleculeSvg(smiles, width, height)
      .then((nextSvg) => {
        if (!cancelled) setRenderState({ value: smiles, svg: nextSvg })
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setRenderState({
          value: smiles,
          error: loadError instanceof Error ? loadError.message : String(loadError)
        })
      })

    return () => {
      cancelled = true
    }
  }, [height, shouldLoad, smiles, width])

  if (svg) {
    return (
      <Box
        component="img"
        data-phi-molecule-preview="true"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
        alt="SMILES molecule structure"
        sx={{
          display: 'block',
          width,
          height,
          maxWidth: 'calc(100vw - 48px)',
          objectFit: 'contain',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'common.white',
          flexShrink: 0
        }}
      />
    )
  }

  const statusText = error
    ? '结构预览加载失败'
    : shouldLoad
      ? '正在加载 RDKit.js 结构预览...'
      : '悬停加载结构预览'

  return (
    <Box
      data-phi-molecule-preview="true"
      title={error}
      sx={{
        width,
        height,
        maxWidth: 'calc(100vw - 48px)',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.default',
        color: error ? 'error.main' : 'text.secondary',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        px: 1,
        fontSize: '0.72rem',
        lineHeight: 1.35,
        flexShrink: 0,
        overflow: 'hidden'
      }}
    >
      <Box
        component="span"
        sx={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {statusText}
      </Box>
    </Box>
  )
}

export function MarkdownSmilesTokenView({ smiles }: { smiles: string }): React.JSX.Element {
  const [previewActive, setPreviewActive] = useState(false)

  return (
    <Tooltip
      title={
        <MoleculePreviewImage
          smiles={smiles}
          width={MOLECULE_HOVER_PREVIEW_WIDTH}
          height={MOLECULE_HOVER_PREVIEW_HEIGHT}
          shouldLoad={previewActive}
        />
      }
      placement="top-start"
      arrow
      slotProps={moleculeTooltipSlotProps}
      enterDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      leaveDelay={80}
      onOpen={() => setPreviewActive(true)}
      onClose={() => setPreviewActive(false)}
    >
      <Box
        component="span"
        data-phi-slot="markdown-smiles-token"
        data-phi-smiles-hover-preview="true"
        sx={{
          display: 'inline-block',
          minWidth: 0,
          maxWidth: '100%',
          mx: 0.15,
          verticalAlign: 'baseline'
        }}
      >
        <Box
          component="code"
          data-phi-molecule-expression="true"
          title="悬停预览 SMILES 分子结构"
          sx={{
            display: 'inline-block',
            minWidth: 0,
            maxWidth: '100%',
            px: 0.6,
            py: 0.2,
            borderRadius: 1,
            bgcolor: 'rgba(148, 163, 184, 0.15)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85em',
            lineHeight: 1.45,
            overflowWrap: 'anywhere',
            cursor: 'help',
            transition: 'background-color 120ms ease',
            '&:hover': {
              bgcolor: 'rgba(56, 189, 248, 0.16)'
            }
          }}
        >
          {smiles}
        </Box>
        <Box
          component="span"
          sx={{
            position: 'absolute',
            width: 1,
            height: 1,
            p: 0,
            m: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0
          }}
        >
          悬停显示 SMILES 分子结构预览
        </Box>
      </Box>
    </Tooltip>
  )
}
