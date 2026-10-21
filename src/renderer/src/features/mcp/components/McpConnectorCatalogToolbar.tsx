import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { useState } from 'react'
import {
  Button,
  Divider,
  Menu,
  MenuItem,
  Popover,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { GoChevronDown, GoFilter } from 'react-icons/go'
import type {
  ConnectorInstallFilter,
  ConnectorSignInFilter,
  ConnectorSort
} from '../lib/featuredConnectorFilters'

const SORT_LABEL: Record<ConnectorSort, string> = {
  get default() {
    return connectorCopy.defaultSort
  },
  get name() {
    return resourceUi.name
  },
  get added() {
    return connectorCopy.configuredFirst
  }
}

export function McpConnectorCatalogToolbar({
  signIn,
  install,
  sort,
  onSignInChange,
  onInstallChange,
  onSortChange
}: {
  signIn: ConnectorSignInFilter
  install: ConnectorInstallFilter
  sort: ConnectorSort
  onSignInChange: (value: ConnectorSignInFilter) => void
  onInstallChange: (value: ConnectorInstallFilter) => void
  onSortChange: (value: ConnectorSort) => void
}): React.JSX.Element {
  useUiLanguage()

  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null)
  const filterActive = signIn !== 'all' || install !== 'all'

  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
      <Button
        color={filterActive ? 'primary' : 'inherit'}
        startIcon={<GoFilter size={16} />}
        onClick={(event) => setFilterAnchor(event.currentTarget)}
        sx={{ color: filterActive ? 'primary.main' : 'text.primary' }}
      >
        {connectorCopy.filter}
      </Button>
      <Button
        color="inherit"
        endIcon={<GoChevronDown size={16} />}
        onClick={(event) => setSortAnchor(event.currentTarget)}
        sx={{ color: 'text.primary' }}
      >
        {connectorCopy.sortBy(SORT_LABEL[sort])}
      </Button>
      <Popover
        open={Boolean(filterAnchor)}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Stack spacing={1.5} sx={{ p: 2, width: 280 }}>
          <Typography variant="caption" color="text.secondary">
            {connectorCopy.signInMethod}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={signIn}
            onChange={(_event, value: ConnectorSignInFilter | null) => {
              if (value) onSignInChange(value)
            }}
            sx={{ flexWrap: 'wrap' }}
          >
            <ToggleButton value="all">{resourceUi.all}</ToggleButton>
            <ToggleButton value="无需登录">{connectorCopy.noSignIn}</ToggleButton>
            <ToggleButton value="需要登录">{connectorCopy.signInRequired}</ToggleButton>
            <ToggleButton value="需要 API key">{connectorCopy.apiKeyLabel}</ToggleButton>
          </ToggleButtonGroup>
          <Divider />
          <Typography variant="caption" color="text.secondary">
            {connectorCopy.configuredState}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={install}
            onChange={(_event, value: ConnectorInstallFilter | null) => {
              if (value) onInstallChange(value)
            }}
          >
            <ToggleButton value="all">{resourceUi.all}</ToggleButton>
            <ToggleButton value="added">{connectorCopy.configured}</ToggleButton>
            <ToggleButton value="not-added">{connectorCopy.notConfigured}</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Popover>
      <Menu anchorEl={sortAnchor} open={Boolean(sortAnchor)} onClose={() => setSortAnchor(null)}>
        {(Object.keys(SORT_LABEL) as ConnectorSort[]).map((value) => (
          <MenuItem
            key={value}
            selected={sort === value}
            onClick={() => {
              onSortChange(value)
              setSortAnchor(null)
            }}
          >
            {SORT_LABEL[value]}
          </MenuItem>
        ))}
      </Menu>
    </Stack>
  )
}
