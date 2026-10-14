import { useState } from 'react'
import { Box, IconButton, Skeleton, Typography } from '@mui/material'
import { FaGithub } from 'react-icons/fa'
import { FiArrowUpRight, FiGlobe } from 'react-icons/fi'
import type { WebLinkPreview } from '../../../../shared/webLinkPreviewTypes'
import { useWebLinkPreview } from './useWebLinkPreview'

type CardProps = {
  url: string
  label: string
  site: 'github' | 'web'
  preview: WebLinkPreview | null
  loading: boolean
  onOpen: () => void
}

export function WebLinkPreviewCard({
  url,
  label,
  site,
  preview,
  loading,
  onOpen
}: CardProps): React.JSX.Element {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const candidateIcon = preview?.iconDataUrl
  const icon =
    candidateIcon &&
    candidateIcon.length <= 96_000 &&
    /^data:image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+=*$/i.test(
      candidateIcon
    )
      ? candidateIcon
      : null
  const available = Boolean(preview?.title || preview?.description)
  const address = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  let hostname = address
  try {
    hostname = new URL(url).hostname
  } catch {
    // Invalid addresses can still use the plain-text fallback in isolated renders.
  }
  const title = preview?.title || (label && label !== url ? label : hostname)

  return (
    <Box
      data-phi-web-link-preview={loading ? 'loading' : available ? 'ready' : 'unavailable'}
      role="group"
      aria-label="网页预览"
      aria-busy={loading}
      sx={{
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 'inherit',
        bgcolor: 'background.paper',
        color: 'text.primary'
      }}
    >
      <Box sx={{ height: 38 }}>
        {loading ? (
          <>
            <Skeleton height={19} width="94%" />
            <Skeleton height={19} width="76%" />
          </>
        ) : (
          <Typography
            data-phi-web-preview-title="true"
            component="div"
            sx={{
              fontSize: 14,
              fontWeight: 500,
              lineHeight: '19px',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden',
              overflowWrap: 'anywhere'
            }}
          >
            {title}
          </Typography>
        )}
      </Box>
      <Box sx={{ height: 54, mt: 0.25 }}>
        {loading ? (
          <>
            <Skeleton height={18} width="100%" />
            <Skeleton height={18} width="100%" />
            <Skeleton height={18} width="72%" />
          </>
        ) : (
          <Typography
            data-phi-web-preview-description="true"
            component="div"
            sx={{
              color: 'text.secondary',
              fontSize: 13,
              lineHeight: '18px',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
              overflow: 'hidden',
              overflowWrap: 'anywhere'
            }}
          >
            {preview?.description || '暂无网页摘要'}
          </Typography>
        )}
      </Box>
      <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 0.75, height: 20 }}>
        {icon && icon !== failedIcon ? (
          <Box
            component="img"
            src={icon}
            alt=""
            aria-hidden="true"
            onError={() => setFailedIcon(icon)}
            sx={{ width: 16, height: 16, flexShrink: 0, objectFit: 'contain', borderRadius: '2px' }}
          />
        ) : site === 'github' ? (
          <FaGithub aria-hidden size={16} style={{ flexShrink: 0 }} />
        ) : (
          <FiGlobe aria-hidden size={16} style={{ flexShrink: 0 }} />
        )}
        <Typography
          data-phi-web-preview-address="true"
          component="span"
          title={url}
          noWrap
          sx={{ color: 'text.secondary', flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '20px' }}
        >
          {address}
        </Typography>
        <IconButton
          aria-label="打开网页"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpen()
          }}
          size="small"
          sx={{ width: 20, height: 20, p: 0.25, flexShrink: 0, color: 'text.secondary' }}
        >
          <FiArrowUpRight aria-hidden size={16} />
        </IconButton>
      </Box>
    </Box>
  )
}

export function WebLinkHoverCard({
  url,
  label,
  site,
  active,
  onOpen
}: Omit<CardProps, 'preview' | 'loading'> & { active: boolean }): React.JSX.Element {
  const state = useWebLinkPreview(url, active)
  return <WebLinkPreviewCard url={url} label={label} site={site} onOpen={onOpen} {...state} />
}
