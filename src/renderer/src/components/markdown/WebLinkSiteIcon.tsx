import { useState } from 'react'
import { Box } from '@mui/material'
import { FaGithub } from 'react-icons/fa'
import { FiGlobe } from 'react-icons/fi'
import { webLinkIconDataUrl } from '../../lib/webLinkIcon'
import { useWebLinkPreview } from './useWebLinkPreview'

function WebLinkFallbackIcon({
  site,
  size
}: {
  site: 'github' | 'web'
  size: number
}): React.JSX.Element {
  const Icon = site === 'github' ? FaGithub : FiGlobe
  return (
    <Box
      component="span"
      data-phi-web-link-icon="fallback"
      sx={{ display: 'inline-flex', flexShrink: 0, lineHeight: 0 }}
    >
      <Icon aria-hidden size={size} />
    </Box>
  )
}

export function WebLinkSiteIcon({
  site,
  iconDataUrl,
  size = 16
}: {
  site: 'github' | 'web'
  iconDataUrl?: string | null
  size?: number
}): React.JSX.Element {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const icon = webLinkIconDataUrl(iconDataUrl)
  if (!icon || icon === failedIcon) return <WebLinkFallbackIcon site={site} size={size} />

  return (
    <Box
      component="img"
      src={icon}
      alt=""
      aria-hidden
      data-phi-web-link-icon="site"
      onError={() => setFailedIcon(icon)}
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        objectFit: 'contain',
        borderRadius: '2px'
      }}
    />
  )
}

/** Loads the page icon for a link and falls back to the built-in site mark. */
export function WebLinkFetchedIcon({
  url,
  site,
  size = 16
}: {
  url: string
  site: 'github' | 'web'
  size?: number
}): React.JSX.Element {
  const { preview } = useWebLinkPreview(url, true)
  return <WebLinkSiteIcon site={site} iconDataUrl={preview?.iconDataUrl} size={size} />
}
