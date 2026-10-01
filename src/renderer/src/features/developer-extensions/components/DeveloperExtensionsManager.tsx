import { Box, Divider, Paper } from '@mui/material'
import type { PluginCatalogItem } from '../../../types'
import { DeveloperExtensionDetail } from './DeveloperExtensionDetail'
import { DeveloperExtensionsSidebar } from './DeveloperExtensionsSidebar'

export type DeveloperExtensionsManagerProps = {
  extensions: PluginCatalogItem[]
  isLoading: boolean
  activeExtensionId: string | null
  busySource: string | null
  operationError: string | null
  onSelectExtension: (id: string) => void
  onInstall: (source: string) => void
  onRemove: (source: string) => void
  onRefresh: () => void
}

export function DeveloperExtensionsManager({
  extensions,
  isLoading,
  activeExtensionId,
  busySource,
  operationError,
  onSelectExtension,
  onInstall,
  onRemove,
  onRefresh
}: DeveloperExtensionsManagerProps): React.JSX.Element {
  const selectedExtension =
    extensions.find((extension) => extension.id === activeExtensionId) ?? null

  return (
    <Paper
      variant="outlined"
      sx={{
        display: 'flex',
        minWidth: 0,
        minHeight: 440,
        height: 'min(510px, calc(100vh - 250px))',
        overflow: 'hidden',
        borderRadius: 1
      }}
    >
      <DeveloperExtensionsSidebar
        extensions={extensions}
        isLoading={isLoading}
        activeExtensionId={activeExtensionId}
        onSelectExtension={(extension) => onSelectExtension(extension.id)}
        onRefresh={onRefresh}
      />
      <Divider orientation="vertical" flexItem />
      <Box sx={{ minWidth: 0, flex: 1, display: 'flex' }}>
        <DeveloperExtensionDetail
          selectedExtension={selectedExtension}
          busySource={busySource}
          operationError={operationError}
          onInstall={onInstall}
          onRemove={onRemove}
        />
      </Box>
    </Paper>
  )
}
