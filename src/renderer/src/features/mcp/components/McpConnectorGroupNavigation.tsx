import { useUiLanguage } from '../../../lib/i18n'
import { Box, List, ListItemButton, Typography } from '@mui/material'
import {
  mcpConnectorCategories,
  type FeaturedMcpConnector
} from '../../../../../shared/mcpConnectorCatalog'
import { resourceCategoryLabel } from '../../../lib/resourceUi'
import { CUSTOM_CONNECTOR_GROUP } from '../lib/customConnectorGroup'
import { connectorCopy } from '../lib/connectorCopy'

type CatalogGroup = (typeof mcpConnectorCategories)[number] | typeof CUSTOM_CONNECTOR_GROUP

export function McpConnectorGroupNavigation({
  connectors,
  customCount,
  group,
  page,
  onSelect
}: {
  connectors: readonly FeaturedMcpConnector[]
  customCount: number
  group: CatalogGroup
  page: 'list' | 'detail'
  onSelect: (group: CatalogGroup) => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Box
      component="nav"
      aria-label={connectorCopy.connectorGroups}
      sx={{
        minHeight: 0,
        overflowY: 'auto',
        px: 1.5,
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.default'
      }}
    >
      <List disablePadding>
        {mcpConnectorCategories
          .map((category) => ({
            category,
            count: connectors.filter((entry) => entry.category === category).length
          }))
          .filter(({ count }) => count > 0)
          .map(({ category, count }) => (
            <ListItemButton
              key={category}
              selected={group === category && page === 'list'}
              onClick={() => onSelect(category)}
              sx={{ borderRadius: 1.5, mb: 0.5 }}
            >
              <Typography variant="body2">
                {resourceCategoryLabel(category)} · {count}
              </Typography>
            </ListItemButton>
          ))}
        <ListItemButton
          key={CUSTOM_CONNECTOR_GROUP}
          selected={group === CUSTOM_CONNECTOR_GROUP && page === 'list'}
          onClick={() => onSelect(CUSTOM_CONNECTOR_GROUP)}
          sx={{ borderRadius: 1.5, mb: 0.5 }}
        >
          <Typography variant="body2">
            {resourceCategoryLabel(CUSTOM_CONNECTOR_GROUP)} · {customCount}
          </Typography>
        </ListItemButton>
      </List>
    </Box>
  )
}
