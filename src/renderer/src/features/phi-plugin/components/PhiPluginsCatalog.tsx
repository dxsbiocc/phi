import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { PhiPluginCard } from './PhiPluginCard'

const FolderIcon = PhiIcons.entity.folder
const PluginIcon = PhiIcons.entity.plugin

export function PhiPluginsCatalog({
  plugins,
  loading,
  busyPluginId,
  onChooseDirectory,
  onSetEnabled,
  onRequestUninstall
}: {
  plugins: readonly PhiPluginDisplayItem[]
  loading: boolean
  busyPluginId: string | null
  onChooseDirectory: () => void
  onSetEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => void
  onRequestUninstall: (plugin: PhiPluginDisplayItem) => void
}): React.JSX.Element {
  if (loading && plugins.length === 0) {
    return (
      <Stack spacing={1.25} sx={{ alignItems: 'center', py: 10 }}>
        <CircularProgress size={30} />
        <Typography variant="body2" color="text.secondary">
          正在读取已安装插件…
        </Typography>
      </Stack>
    )
  }

  if (plugins.length === 0) {
    return (
      <Stack
        spacing={1}
        sx={{
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          py: 10,
          px: 3,
          border: 1,
          borderStyle: 'dashed',
          borderColor: 'divider',
          borderRadius: 2
        }}
      >
        <PluginIcon color="disabled" sx={{ fontSize: 38 }} />
        <Typography variant="h6">尚未安装 Phi 插件</Typography>
        <Typography variant="body2" color="text.secondary">
          选择包含 phi-package.yaml 的本地目录开始安装。
        </Typography>
        <Button
          sx={{ mt: 1 }}
          variant="outlined"
          startIcon={<FolderIcon />}
          onClick={onChooseDirectory}
        >
          选择插件目录
        </Button>
      </Stack>
    )
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
        gap: 2
      }}
    >
      {plugins.map((plugin) => (
        <PhiPluginCard
          key={plugin.id}
          plugin={plugin}
          busy={busyPluginId === plugin.id}
          disabled={busyPluginId !== null}
          onSetEnabled={(enabled) => onSetEnabled(plugin, enabled)}
          onRequestUninstall={() => onRequestUninstall(plugin)}
        />
      ))}
    </Box>
  )
}
