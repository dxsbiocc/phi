import { useUiLanguage } from '../../../lib/i18n'
import { Chip, Stack } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { connectorSourceLabel } from '../lib/connectorSourceLabel'

export function McpConnectorSourceBadges({
  connector
}: {
  connector: FeaturedMcpConnector
}): React.JSX.Element | null {
  useUiLanguage()

  if (!connector.source) return null
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: 'center', flexWrap: 'nowrap', flexShrink: 0 }}
    >
      <Chip
        size="small"
        variant="outlined"
        label={connectorSourceLabel(connector)}
        sx={{ flexShrink: 0 }}
      />
    </Stack>
  )
}
