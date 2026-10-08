import { useEffect, useRef, useState } from 'react'
import { Box, type SxProps, type Theme } from '@mui/material'
import type { ResourceIconRef } from '../../../shared/resourceIconTypes'
import { PhiIcons } from '../icons'
import { observeResourceIconVisibility, resourceIconCache } from '../lib/resourceIcons'

export type ResourceIconProps = {
  icon?: ResourceIconRef
  kind: 'mcp' | 'plugin' | 'skill' | 'wrapper'
  size?: number
  fallbackSize?: number
  sx?: SxProps<Theme>
}

/** Resource-owned images remain decorative beside the resource's accessible name. */
export function ResourceIcon({
  icon,
  kind,
  size = 32,
  fallbackSize = Math.round(size * 0.6),
  sx = []
}: ResourceIconProps): React.JSX.Element {
  const key = icon?.key
  const node = useRef<HTMLDivElement | null>(null)
  const [loaded, setLoaded] = useState<{ key: string; source: string | null } | null>(null)
  const source = key ? (loaded?.key === key ? loaded.source : resourceIconCache.peek(key)) : null
  const FallbackIcon = PhiIcons.entity[kind]

  useEffect(() => {
    if (!key || !node.current) return undefined
    let mounted = true
    const load = (): void => {
      void resourceIconCache.read(key).then((source) => {
        if (mounted) setLoaded({ key, source })
      })
    }
    const cached = resourceIconCache.peek(key)
    if (cached !== undefined) load()
    const stopObserving =
      cached === undefined ? observeResourceIconVisibility(node.current, load) : () => undefined
    return () => {
      mounted = false
      stopObserving()
    }
  }, [key])

  return (
    <Box
      ref={node}
      aria-hidden="true"
      data-phi-resource-icon={kind}
      data-phi-resource-icon-key={key}
      sx={[
        {
          width: size,
          height: size,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'inherit',
          overflow: 'hidden'
        },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
    >
      {source ? (
        <Box
          component="img"
          src={source}
          alt=""
          draggable={false}
          onError={() => {
            resourceIconCache.markFailed(key!, source)
            setLoaded({ key: key!, source: null })
          }}
          sx={{ width: '100%', height: '100%', objectFit: 'contain', bgcolor: '#FFFFFF' }}
        />
      ) : (
        <FallbackIcon size={fallbackSize} />
      )}
    </Box>
  )
}
