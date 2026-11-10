import { useUiLanguage } from '../../lib/i18n'
import { visualizationCopy } from './lib/visualizationCopy'
import {
  filteredVisualizationGroups,
  selectedVisualizationGroupId,
  visibleVisualizationTemplates
} from './lib/visualizationTemplates'
import { OverlayScroll } from '../../components/OverlayScroll'
import { useVisualizationTemplates } from './hooks/useVisualizationTemplates'
import { useState } from 'react'
import { Alert, Box, CircularProgress, TextField, Typography } from '@mui/material'

import type {
  VisualizationTemplate,
  VisualizationTemplateCatalog
} from '../../../../shared/visualizationTemplateTypes'
import { VisualizationGroupPanel } from './components/VisualizationGroupPanel'
import {
  VisualizationTemplateDialog,
  VisualizationTemplateGrid
} from './components/VisualizationTemplateGrid'

function GalleryResults({
  error,
  loading,
  templates,
  emptyLabel,
  onOpen
}: {
  error: string | null
  loading: boolean
  templates: readonly VisualizationTemplate[]
  emptyLabel: string
  onOpen: (template: VisualizationTemplate) => void
}): React.JSX.Element {
  useUiLanguage()
  if (loading) {
    return (
      <Box
        data-phi-visualization-loading="true"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 8 }}
      >
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          {visualizationCopy.loadingTemplates}
        </Typography>
      </Box>
    )
  }

  return (
    <>
      {error ? (
        <Alert severity="error" variant="outlined" sx={{ m: 2 }}>
          {error}
        </Alert>
      ) : null}
      <VisualizationTemplateGrid templates={templates} emptyLabel={emptyLabel} onOpen={onOpen} />
    </>
  )
}

function useGroupScrollRequest(): {
  nonce: number
  selectedGroupId: string | null
  selectGroup: (groupId: string | null) => void
} {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const selectGroup = (groupId: string | null): void => {
    setSelectedGroupId(groupId)
    setNonce((current) => current + 1)
  }
  return { nonce, selectedGroupId, selectGroup }
}

function GalleryPreviewDialog({
  templates,
  openPath,
  onOpenPath
}: {
  templates: readonly VisualizationTemplate[]
  openPath: string | null
  onOpenPath: (path: string | null) => void
}): React.JSX.Element {
  const openIndex = templates.findIndex((template) => template.previewPath === openPath)
  const openAt = (index: number): void => {
    const template = templates[index]
    if (template) onOpenPath(template.previewPath)
  }
  return (
    <VisualizationTemplateDialog
      template={openIndex >= 0 ? templates[openIndex] : null}
      hasPrevious={openIndex > 0}
      hasNext={openIndex >= 0 && openIndex < templates.length - 1}
      previousPath={templates[openIndex - 1]?.previewPath}
      nextPath={templates[openIndex + 1]?.previewPath}
      onPrevious={() => openAt(openIndex - 1)}
      onNext={() => openAt(openIndex + 1)}
      onClose={() => onOpenPath(null)}
    />
  )
}

export function VisualizationPanel({
  catalog: providedCatalog
}: {
  catalog?: VisualizationTemplateCatalog
}): React.JSX.Element {
  useUiLanguage()
  const loaded = useVisualizationTemplates(providedCatalog === undefined)
  const catalog = providedCatalog ?? loaded.catalog
  const loading = providedCatalog === undefined && loaded.loading
  const error = providedCatalog === undefined ? loaded.error : null
  const [query, setQuery] = useState('')
  const [openPreviewPath, setOpenPreviewPath] = useState<string | null>(null)
  const group = useGroupScrollRequest()
  const groups = catalog?.groups ?? []
  const filteredGroups = filteredVisualizationGroups(groups, query)
  const activeGroupId = selectedVisualizationGroupId(filteredGroups, group.selectedGroupId)
  const templates = visibleVisualizationTemplates(groups, query, group.selectedGroupId)

  return (
    <Box
      data-phi-visualization-gallery="true"
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        maxWidth: 940,
        mx: 'auto',
        px: { xs: 2.5, md: 4 },
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box sx={{ pt: 0.5, pb: 1.5, flexShrink: 0 }}>
        <TextField
          fullWidth
          size="small"
          value={query}
          placeholder={visualizationCopy.searchTemplates}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{ htmlInput: { 'aria-label': visualizationCopy.searchTemplates } }}
        />
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          borderTop: 1,
          borderColor: 'divider'
        }}
      >
        <VisualizationGroupPanel
          groups={filteredGroups}
          selectedGroupId={activeGroupId}
          totalCount={filteredGroups.reduce((count, group) => count + group.templates.length, 0)}
          onSelect={group.selectGroup}
        />
        <OverlayScroll scrollKey={group.nonce} sx={{ flex: 1 }}>
          <GalleryResults
            error={error}
            loading={loading}
            templates={templates}
            emptyLabel={
              groups.length === 0 ? visualizationCopy.noTemplates : visualizationCopy.noMatches
            }
            onOpen={(template) => setOpenPreviewPath(template.previewPath)}
          />
        </OverlayScroll>
      </Box>
      <GalleryPreviewDialog
        templates={templates}
        openPath={openPreviewPath}
        onOpenPath={setOpenPreviewPath}
      />
    </Box>
  )
}
