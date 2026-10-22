import { Box, Typography } from '@mui/material'
import { TbDeviceDesktop } from 'react-icons/tb'

const remoteColors = ['#166F86', '#7358A6', '#A85D3F', '#3D719C', '#91624F']

function remoteMonogram(label: string): string {
  const words = label
    .trim()
    .split(/[\s_-]+/u)
    .filter(Boolean)
  const letters =
    words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [...label].slice(0, 2)
  return letters.join('').toLocaleUpperCase() || 'SSH'
}

function remoteColor(label: string): string {
  const hash = [...label.toLocaleLowerCase()].reduce(
    (value, character) => (Math.imul(value, 31) + (character.codePointAt(0) ?? 0)) >>> 0,
    0
  )
  return remoteColors[hash % remoteColors.length]
}

export function RuntimeServerBadge({
  kind,
  label
}: {
  kind: 'local' | 'ssh'
  label: string
}): React.JSX.Element {
  return (
    <Box
      aria-hidden="true"
      data-phi-runtime-server-badge={kind}
      sx={{
        width: 36,
        height: 36,
        mr: 1.25,
        borderRadius: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: kind === 'local' ? 'primary.main' : remoteColor(label),
        color: kind === 'local' ? 'primary.contrastText' : '#fff',
        flexShrink: 0
      }}
    >
      {kind === 'local' ? (
        <TbDeviceDesktop size={21} />
      ) : (
        <Typography
          component="span"
          sx={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.4 }}
        >
          {remoteMonogram(label)}
        </Typography>
      )}
    </Box>
  )
}
