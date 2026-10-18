import { useUiLanguage } from '../../../lib/i18n'
import { pluginCopy } from '../lib/pluginCopy'
import { useState } from 'react'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  PHI_PLUGIN_APPROVAL_LABELS,
  PHI_PLUGIN_COMPONENT_LABELS,
  phiPluginInspectableComponents,
  type PhiPluginComponentKind,
  type PhiPluginInspectableComponent
} from '../lib/phiPluginComponents'
import { PhiPluginComponentDialog } from './PhiPluginComponentDialog'

const COMPONENT_ICONS = {
  agent: PhiIcons.entity.agent,
  skill: PhiIcons.entity.skill,
  script: PhiIcons.tool.command
}
const SECTION_LABELS = pluginCopy.componentSections
const EMPTY_LABELS = pluginCopy.emptyComponents

function ComponentItem({
  component,
  onInspect
}: {
  component: PhiPluginInspectableComponent
  onInspect: () => void
}): React.JSX.Element {
  useUiLanguage()

  const Icon = COMPONENT_ICONS[component.kind]
  return (
    <ButtonBase
      onClick={onInspect}
      aria-label={pluginCopy.inspectComponent(
        PHI_PLUGIN_COMPONENT_LABELS[component.kind],
        component.name
      )}
      aria-haspopup="dialog"
      data-phi-plugin-component={component.key}
      sx={{
        p: 1.25,
        gap: 1.25,
        width: '100%',
        minWidth: 0,
        borderRadius: 1.5,
        textAlign: 'left',
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
        '&:hover': { bgcolor: 'action.hover' },
        '&.Mui-focusVisible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2
        }
      }}
    >
      <Box
        component="span"
        data-phi-component-icon={component.kind}
        sx={{
          display: 'grid',
          placeItems: 'center',
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: 1.25,
          color: 'primary.main',
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.09)
        }}
      >
        <Icon size={22} />
      </Box>
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          component="span"
          variant="subtitle2"
          sx={{
            display: 'block',
            overflowWrap: 'anywhere',
            ...(component.kind === 'script' ? { fontFamily: 'var(--font-mono)' } : {})
          }}
        >
          {component.name}
        </Typography>
        {component.description && (
          <Typography
            component="span"
            variant="body2"
            color="text.secondary"
            noWrap
            data-phi-description-truncated="true"
            sx={{ display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {component.description}
          </Typography>
        )}
        {component.kind === 'script' && (component.approval || component.skillName) && (
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}
          >
            {component.approval
              ? `${pluginCopy.approval}: ${PHI_PLUGIN_APPROVAL_LABELS[component.approval]}`
              : ''}
            {component.approval && component.skillName ? ' · ' : ''}
            {component.skillName ? `${pluginCopy.ownerSkill}: ${component.skillName}` : ''}
          </Typography>
        )}
      </Box>
      <PhiIcons.action.back size={16} sx={{ color: 'text.secondary', flexShrink: 0, mt: 0.25 }} />
    </ButtonBase>
  )
}

export function PhiPluginComponentDetails({
  plugin
}: {
  plugin: PhiPluginDisplayItem
}): React.JSX.Element {
  useUiLanguage()

  const components = phiPluginInspectableComponents(plugin)
  const owner = `${plugin.id}@${plugin.version}`
  const [selected, setSelected] = useState<{ owner: string; key: string } | null>(null)
  const [open, setOpen] = useState(false)
  const inspected =
    selected?.owner === owner
      ? components.find((component) => component.key === selected.key)
      : undefined
  if (selected && !inspected) {
    setSelected(null)
    setOpen(false)
  }
  const SelectedIcon = inspected ? COMPONENT_ICONS[inspected.kind] : null

  return (
    <>
      <Stack spacing={2} data-phi-plugin-component-details="true">
        {(['agent', 'skill', 'script'] as const).map((kind: PhiPluginComponentKind) => {
          const items = components.filter((component) => component.kind === kind)
          return (
            <Box
              key={kind}
              component="section"
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '160px minmax(0, 1fr)' },
                columnGap: 2,
                rowGap: 0.75,
                alignItems: 'start'
              }}
            >
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: '24px' }}>
                {SECTION_LABELS[kind]}
              </Typography>
              {items.length > 0 ? (
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
                    gap: 0.75,
                    minWidth: 0
                  }}
                >
                  {items.map((component) => (
                    <ComponentItem
                      key={component.key}
                      component={component}
                      onInspect={() => {
                        setSelected({ owner, key: component.key })
                        setOpen(true)
                      }}
                    />
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {EMPTY_LABELS[kind]}
                </Typography>
              )}
            </Box>
          )
        })}
      </Stack>
      {inspected && SelectedIcon && (
        <PhiPluginComponentDialog
          plugin={plugin}
          component={inspected}
          open={open}
          icon={<SelectedIcon size={24} />}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
