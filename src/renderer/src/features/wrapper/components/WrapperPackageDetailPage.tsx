import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'

import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest
} from '../../../../../shared/wrapperCompositionManifestTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import { useWrapperPackageMembers } from '../hooks/useWrapperPackageMembers'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { filterWrapperMembers, wrapperParamRows } from '../lib/wrapperPackageDetail'

const KIND_LABEL = { input: '输入', option: '选项', output: '输出' } as const

export interface WrapperPackageDetailPageProps {
  choice: WrapperCatalogChoice
  catalog: readonly WrapperCompositionCatalogItem[]
  /** The install / add / enable control, shared with the catalog table. */
  action: React.ReactNode
  onBack: () => void
}

/** One package's wrappers: a tool list on the left and the selected wrapper's contract on the right. */
export function WrapperPackageDetailPage({
  choice,
  catalog,
  action,
  onBack
}: WrapperPackageDetailPageProps): React.JSX.Element {
  const members = useWrapperPackageMembers(catalog, choice)
  const [query, setQuery] = useState('')
  const [pickedId, setPickedId] = useState<string | null>(null)
  const visible = useMemo(
    () => filterWrapperMembers(members.wrappers, query),
    [members.wrappers, query]
  )
  const selected =
    visible.find((entry) => entry.id === pickedId) ??
    members.wrappers.find((entry) => entry.id === pickedId) ??
    visible[0]

  return (
    <Box
      data-phi-wrapper-package-detail={choice.id}
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 2 }}>
        <Button
          size="small"
          aria-label="返回 wrapper 目录"
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          返回
        </Button>
        <ResourceIcon
          icon={choice.cached?.icon ?? choice.registryEntry?.icon}
          kind="wrapper"
          sx={{ color: 'primary.main' }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>
            {choice.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap title={choice.summary}>
            {choice.summary}
          </Typography>
        </Box>
        <Chip size="small" label={choice.category} />
        {choice.version ? (
          <Chip size="small" variant="outlined" label={`v${choice.version}`} />
        ) : null}
        {action}
      </Stack>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '280px minmax(0, 1fr)' },
          borderTop: 1,
          borderColor: 'divider'
        }}
      >
        <Box
          component="nav"
          aria-label="包内工具"
          sx={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: { xs: 0, md: 1 },
            borderColor: 'divider',
            bgcolor: 'background.default'
          }}
        >
          {members.wrappers.length > 6 ? (
            <Box sx={{ p: 1.5 }}>
              <TextField
                fullWidth
                size="small"
                value={query}
                placeholder="搜索包内工具"
                onChange={(event) => setQuery(event.target.value)}
                slotProps={{
                  htmlInput: { 'aria-label': '搜索包内工具' },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <PhiIcons.action.search size={16} />
                      </InputAdornment>
                    )
                  }
                }}
              />
            </Box>
          ) : null}
          <List disablePadding sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1.5 }}>
            {visible.map((entry) => (
              <ListItemButton
                key={entry.id}
                selected={entry.id === selected?.id}
                aria-pressed={entry.id === selected?.id}
                data-phi-wrapper-member={entry.id}
                onClick={() => setPickedId(entry.id)}
                sx={{ borderRadius: 1.5, mb: 0.5 }}
              >
                <Typography variant="body2" noWrap title={entry.name} sx={{ flex: 1 }}>
                  {entry.name}
                </Typography>
              </ListItemButton>
            ))}
            {members.status === 'ready' && visible.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                没有匹配的工具
              </Typography>
            ) : null}
          </List>
        </Box>
        <Box sx={{ minWidth: 0, minHeight: 0, overflow: 'auto', p: 3 }}>
          {members.status === 'loading' ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
              <CircularProgress size={22} />
            </Box>
          ) : members.status === 'error' ? (
            <Alert severity="error">{members.error}</Alert>
          ) : selected ? (
            <WrapperDetail manifest={selected} skipped={members.skipped} />
          ) : (
            <Typography color="text.secondary">这个软件包里没有可显示的 wrapper。</Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}

function WrapperDetail({
  manifest,
  skipped
}: {
  manifest: WrapperCompositionManifest
  skipped: number
}): React.JSX.Element {
  const params = wrapperParamRows(manifest)
  const outputs = Object.entries(manifest.outputs)
  return (
    <Stack spacing={2.5}>
      {skipped > 0 ? (
        <Alert severity="warning">有 {skipped} 个 wrapper 的清单无法解析，已跳过。</Alert>
      ) : null}
      <Box>
        <Typography variant="h6">{manifest.name}</Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
        >
          {manifest.id}
        </Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>
          {manifest.summary}
        </Typography>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          参数
        </Typography>
        {params.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            没有声明参数。
          </Typography>
        ) : (
          <Table size="small" aria-label="参数">
            <TableHead>
              <TableRow>
                <TableCell>名称</TableCell>
                <TableCell>类别</TableCell>
                <TableCell>类型</TableCell>
                <TableCell>说明</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {params.map((row) => (
                <TableRow key={row.name}>
                  <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                    {row.name}
                    {row.required ? ' *' : ''}
                  </TableCell>
                  <TableCell>{KIND_LABEL[row.kind]}</TableCell>
                  <TableCell>{row.type}</TableCell>
                  <TableCell sx={{ overflowWrap: 'anywhere' }}>
                    {row.description}
                    {row.constraint ? (
                      <Typography variant="caption" color="text.secondary" component="div">
                        {row.constraint}
                      </Typography>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" color="text.secondary">
          * 必填
        </Typography>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          输出
        </Typography>
        <Table size="small" aria-label="输出">
          <TableHead>
            <TableRow>
              <TableCell>名称</TableCell>
              <TableCell>类型</TableCell>
              <TableCell>路径</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {outputs.map(([name, output]) => (
              <TableRow key={name}>
                <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {name}
                  {output.primary ? <Chip size="small" label="主输出" sx={{ ml: 1 }} /> : null}
                </TableCell>
                <TableCell>{output.type}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {output.path}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Stack>
  )
}
