import { useUiLanguage } from '../../../lib/i18n'
import { resourceSourceLabel } from '../../../lib/resourceUi'
import { Chip, Stack } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

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
        label={resourceSourceLabel(connector.source.label)}
        sx={{ flexShrink: 0 }}
      />
    </Stack>
  )
}
