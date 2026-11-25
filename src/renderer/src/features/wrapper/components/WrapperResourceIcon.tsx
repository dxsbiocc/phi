import { Box } from '@mui/material'
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import { resolveWrapperTierKind, wrapperTierPaletteColor } from '../lib/wrapperView'

export interface WrapperResourceIconProps {
  icon?: ResourceIconRef
  tier?: string
  size?: number
  fallbackSize?: number
  borderRadius?: number
  enabled?: boolean
  variant?: 'tinted' | 'solid'
  sx?: SxProps<Theme>
}

/**
 * Renders a Wrapper's owned logo when present, falling back to a tier-distinct badge
 * (`module` / `subworkflow` / `workflow`) instead of repeating one generic glyph.
 */
export function WrapperResourceIcon({
  icon,
  tier,
  size = 32,
  fallbackSize = Math.round(size * 0.56),
  borderRadius = 1.5,
  enabled = true,
  variant = 'tinted',
  sx = []
}: WrapperResourceIconProps): React.JSX.Element {
  const tierKind = resolveWrapperTierKind(tier)
  const paletteKey = wrapperTierPaletteColor(tierKind)
  const FallbackIcon = PhiIcons.wrapperTier[tierKind]

  return (
    <Box
      data-phi-wrapper-tier={tierKind}
      sx={[
        (theme) => {
          const palette = theme.palette[paletteKey]
          if (!enabled) {
            return {
              width: size,
              height: size,
              borderRadius,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              bgcolor: theme.palette.action.hover,
              color: theme.palette.text.secondary
            }
          }
          if (variant === 'solid') {
            return {
              width: size,
              height: size,
              borderRadius,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              bgcolor: palette.main,
              color: palette.contrastText
            }
          }
          return {
            width: size,
            height: size,
            borderRadius,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            bgcolor: alpha(palette.main, theme.palette.mode === 'dark' ? 0.22 : 0.12),
            color: palette.main
          }
        },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
    >
      <ResourceIcon
        icon={icon}
        kind="wrapper"
        fallbackIcon={FallbackIcon}
        size={size}
        fallbackSize={fallbackSize}
      />
    </Box>
  )
}
