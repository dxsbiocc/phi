import { Box, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'

export type MolstarStructureSource =
  | { kind: 'pdb-id'; value: string; label?: string }
  | { kind: 'url'; value: string; format: 'mmcif' | 'pdb'; label?: string }
  | { kind: 'data'; value: string; format: 'mmcif' | 'pdb'; label?: string }

type DisposableMolstarPlugin = {
  dispose: (options?: { doNotForceWebGLContextLoss?: boolean }) => void
}

type StructureLoadState = {
  sourceKey: string
  status: string
}

function sourceKey(source: MolstarStructureSource | null): string {
  if (!source) return 'none'
  if (source.kind === 'data') {
    return [
      source.kind,
      source.format,
      source.label ?? '',
      source.value.length,
      source.value.slice(0, 120),
      source.value.slice(-120)
    ].join(':')
  }
  if (source.kind === 'url') return [source.kind, source.format, source.value].join(':')
  return [source.kind, source.value].join(':')
}

export function MolstarStructureViewer({
  source,
  height = 260,
  emptyMessage = '没有可渲染的 PDB/mmCIF 标识'
}: {
  source: MolstarStructureSource | null
  height?: number
  emptyMessage?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pluginRef = useRef<DisposableMolstarPlugin | null>(null)
  const activeSourceKey = sourceKey(source)
  const [loadState, setLoadState] = useState<StructureLoadState | null>(null)
  const status =
    loadState?.sourceKey === activeSourceKey
      ? loadState.status
      : source
        ? '正在加载 Mol* 结构预览...'
        : emptyMessage

  useEffect(() => {
    const target = containerRef.current
    if (!target || !source) return
    const targetElement = target
    const sourceValue = source
    const loadKey = activeSourceKey
    let cancelled = false

    async function loadStructure(): Promise<void> {
      const [{ createPluginUI }, { DefaultPluginUISpec }, { renderReact18 }, loaders] =
        await Promise.all([
          import('molstar/lib/mol-plugin-ui'),
          import('molstar/lib/mol-plugin-ui/spec'),
          import('molstar/lib/mol-plugin-ui/react18'),
          import('molstar/lib/extensions/plugin/loaders')
        ])

      const spec = DefaultPluginUISpec()
      spec.layout = {
        initial: {
          isExpanded: false,
          showControls: false,
          regionState: {
            left: 'hidden',
            right: 'hidden',
            top: 'hidden',
            bottom: 'hidden'
          }
        }
      }
      spec.components = {
        ...(spec.components ?? {}),
        controls: { top: 'none', left: 'none', right: 'none', bottom: 'none' },
        hideTaskOverlay: true
      }

      const plugin = await createPluginUI({ target: targetElement, render: renderReact18, spec })
      if (cancelled) {
        plugin.dispose()
        return
      }
      pluginRef.current = plugin

      if (sourceValue.kind === 'pdb-id') {
        await loaders.loadPdb(plugin, sourceValue.value)
      } else if (sourceValue.kind === 'url') {
        await loaders.loadStructureFromUrl(plugin, sourceValue.value, sourceValue.format, false, {
          label: sourceValue.label ?? sourceValue.value
        })
      } else {
        await loaders.loadStructureFromData(plugin, sourceValue.value, sourceValue.format, {
          dataLabel: sourceValue.label
        })
      }

      if (!cancelled) setLoadState({ sourceKey: loadKey, status: '' })
    }

    void loadStructure().catch((error: unknown) => {
      if (cancelled) return
      setLoadState({
        sourceKey: loadKey,
        status: error instanceof Error ? error.message : String(error)
      })
    })

    return () => {
      cancelled = true
      pluginRef.current?.dispose()
      pluginRef.current = null
      target.replaceChildren()
    }
  }, [activeSourceKey, source])

  if (!source) {
    return (
      <Typography variant="caption" color="text.secondary">
        {status}
      </Typography>
    )
  }

  return (
    <Box
      sx={{
        position: 'relative',
        height,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: '#081E24',
        overflow: 'hidden',
        '& .msp-plugin': {
          position: 'absolute',
          inset: 0
        }
      }}
    >
      <Box ref={containerRef} sx={{ position: 'absolute', inset: 0 }} />
      {status ? (
        <Typography
          variant="caption"
          sx={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 10,
            color: status.startsWith('正在') ? 'text.secondary' : 'error.main',
            bgcolor: 'rgba(8, 30, 36, 0.82)',
            px: 1,
            py: 0.5,
            borderRadius: 1
          }}
        >
          {status}
        </Typography>
      ) : null}
    </Box>
  )
}
