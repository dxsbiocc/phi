import { Box } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'

import { agentAvatarUrlForDisplayName } from '../lib/agentAvatar'

export type AgentAvatarProps = {
  displayName: string
  size?: number
  decorative?: boolean
  sx?: SxProps<Theme>
}

/** Bundled avatar artwork for an agent or General run. */
export function AgentAvatar({
  displayName,
  size = 20,
  decorative = false,
  sx
}: AgentAvatarProps): React.JSX.Element {
  const styles = [
    {
      width: size,
      height: size,
      flexShrink: 0,
      borderRadius: '25%',
      objectFit: 'cover',
      display: 'block'
    },
    ...(Array.isArray(sx) ? sx : [sx])
  ].filter(Boolean) as SxProps<Theme>

  return (
    <Box
      component="img"
      src={agentAvatarUrlForDisplayName(displayName)}
      alt={displayName}
      aria-hidden={decorative || undefined}
      sx={styles}
    />
  )
}
