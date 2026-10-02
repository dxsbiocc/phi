import { Box, Stack, Typography } from '@mui/material'
import { DeveloperExtensionsManager } from './components/DeveloperExtensionsManager'
import { PackageSourcesSection } from './components/PackageSourcesSection'
import { useDeveloperExtensionCatalog } from './hooks/useDeveloperExtensionCatalog'

export { DeveloperExtensionDetail } from './components/DeveloperExtensionDetail'
export { DeveloperExtensionsManager } from './components/DeveloperExtensionsManager'
export { DeveloperExtensionsSidebar } from './components/DeveloperExtensionsSidebar'

export default function DeveloperExtensionsView(): React.JSX.Element {
  const {
    extensions,
    activeExtensionId,
    isLoadingExtensions,
    busyExtensionSource,
    extensionOperationError,
    setActiveExtensionId,
    refreshExtensions,
    installExtension,
    removeExtension
  } = useDeveloperExtensionCatalog()

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">开发者扩展</Typography>
        <Typography variant="body2" color="text.secondary">
          管理由 Pi runtime 提供的开发者扩展。安装和移除会使用现有的 Pi 扩展源。
        </Typography>
      </Box>

      <DeveloperExtensionsManager
        extensions={extensions}
        isLoading={isLoadingExtensions}
        activeExtensionId={activeExtensionId}
        busySource={busyExtensionSource}
        operationError={extensionOperationError}
        onSelectExtension={setActiveExtensionId}
        onInstall={(source) => void installExtension(source)}
        onRemove={(source) => void removeExtension(source)}
        onRefresh={() => void refreshExtensions()}
      />
      <PackageSourcesSection />
    </Stack>
  )
}
