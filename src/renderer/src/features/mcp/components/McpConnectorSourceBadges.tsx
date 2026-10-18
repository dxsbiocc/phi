import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
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
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip size="small" variant="outlined" label={resourceSourceLabel(connector.source.label)} />
      {connector.source.trust === 'imported' && (
        <Chip size="small" variant="outlined" color="warning" label={resourceUi.unsigned} />
      )}
    </Stack>
  )
}
