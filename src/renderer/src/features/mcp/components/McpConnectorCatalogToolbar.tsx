import { useState } from 'react'
import {
  Box,
  Button,
  Divider,
  InputAdornment,
  Menu,
  MenuItem,
  Popover,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { GoChevronDown, GoFilter } from 'react-icons/go'
import { PhiIcons } from '../../../icons'
import type {
  ConnectorInstallFilter,
  ConnectorSignInFilter,
  ConnectorSort
} from '../lib/featuredConnectorFilters'

const SORT_LABEL: Record<ConnectorSort, string> = {
  default: '默认',
  name: '名称',
  added: '已添加优先'
}

export function McpConnectorCatalogToolbar({
  query,
  signIn,
  install,
  sort,
  onQueryChange,
  onSignInChange,
  onInstallChange,
  onSortChange
}: {
  query: string
  signIn: ConnectorSignInFilter
  install: ConnectorInstallFilter
  sort: ConnectorSort
  onQueryChange: (value: string) => void
  onSignInChange: (value: ConnectorSignInFilter) => void
  onInstallChange: (value: ConnectorInstallFilter) => void
  onSortChange: (value: ConnectorSort) => void
}): React.JSX.Element {
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null)
  const filterActive = signIn !== 'all' || install !== 'all'

  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
      <TextField
        size="small"
        placeholder="搜索连接器"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <PhiIcons.action.search fontSize="small" />
              </InputAdornment>
            )
          }
        }}
        sx={{ width: { xs: 220, md: 320 } }}
      />
      <Box sx={{ flex: 1 }} />
      <Button
        color={filterActive ? 'primary' : 'inherit'}
        startIcon={<GoFilter size={16} />}
        onClick={(event) => setFilterAnchor(event.currentTarget)}
        sx={{ color: filterActive ? 'primary.main' : 'text.primary' }}
      >
        筛选
      </Button>
      <Button
        color="inherit"
        endIcon={<GoChevronDown size={16} />}
        onClick={(event) => setSortAnchor(event.currentTarget)}
        sx={{ color: 'text.primary' }}
      >
        排序：{SORT_LABEL[sort]}
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
            登录方式
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
            <ToggleButton value="all">全部</ToggleButton>
            <ToggleButton value="无需登录">无需登录</ToggleButton>
            <ToggleButton value="需要登录">需要登录</ToggleButton>
            <ToggleButton value="需要 API key">API key</ToggleButton>
          </ToggleButtonGroup>
          <Divider />
          <Typography variant="caption" color="text.secondary">
            添加状态
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={install}
            onChange={(_event, value: ConnectorInstallFilter | null) => {
              if (value) onInstallChange(value)
            }}
          >
            <ToggleButton value="all">全部</ToggleButton>
            <ToggleButton value="added">已添加</ToggleButton>
            <ToggleButton value="not-added">未添加</ToggleButton>
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
