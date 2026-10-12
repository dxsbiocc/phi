import { Chip, Stack } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export function McpConnectorSourceBadges({
  connector
}: {
  connector: FeaturedMcpConnector
}): React.JSX.Element | null {
  if (!connector.source) return null
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip size="small" variant="outlined" label={connector.source.label} />
      {connector.source.trust === 'imported' && (
        <Chip size="small" variant="outlined" color="warning" label="未签名" />
      )}
    </Stack>
  )
}
