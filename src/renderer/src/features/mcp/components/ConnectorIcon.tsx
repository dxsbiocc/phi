import { Box } from '@mui/material'
import { PhiIcons } from '../../../icons'

const icons: Record<string, string> = {
  'google-drive': new URL('../assets/google-drive.svg', import.meta.url).href,
  gmail: new URL('../assets/gmail.svg', import.meta.url).href,
  notion: new URL('../assets/notion.svg', import.meta.url).href,
  composio: new URL('../assets/composio.svg', import.meta.url).href,
  tavily: new URL('../assets/tavily.svg', import.meta.url).href,
  serpapi: new URL('../assets/serpapi.svg', import.meta.url).href,
  firecrawl: new URL('../assets/firecrawl.png', import.meta.url).href,
  'browser-use': new URL('../assets/browser-use.png', import.meta.url).href,
  linear: new URL('../assets/linear.svg', import.meta.url).href,
  slack: new URL('../assets/slack.svg', import.meta.url).href,
  figma: new URL('../assets/figma.jpg', import.meta.url).href,
  canva: new URL('../assets/canva.jpg', import.meta.url).href,
  biorender: new URL('../assets/biorender.jpg', import.meta.url).href,
  pubmed: new URL('../assets/pubmed.svg', import.meta.url).href,
  biorxiv: new URL('../assets/biorxiv.png', import.meta.url).href,
  'clinical-trials': new URL('../assets/clinical-trials.png', import.meta.url).href,
  'open-targets': new URL('../assets/open-targets.svg', import.meta.url).href
}

export function ConnectorIcon({
  connectorId,
  size = 48
}: {
  connectorId?: string
  size?: number
}): React.JSX.Element {
  const id = connectorId
  const source = id ? icons[id] : undefined

  return (
    <Box
      aria-hidden="true"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        overflow: 'hidden',
        bgcolor: '#FFFFFF'
      }}
    >
      {source ? (
        <Box
          component="img"
          src={source}
          alt=""
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            p: id && ['composio', 'figma', 'canva', 'biorender'].includes(id) ? 0 : 0.25
          }}
        />
      ) : (
        <PhiIcons.entity.mcp size={Math.round(size * 0.55)} />
      )}
    </Box>
  )
}
