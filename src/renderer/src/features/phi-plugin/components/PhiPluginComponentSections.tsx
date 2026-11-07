import { useUiLanguage } from '../../../lib/i18n'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import { PhiIcons } from '../../../icons'
import type { PhiPluginScriptToolDetail } from '../../../../../shared/phiPluginTypes'
import { pluginCopy } from '../lib/pluginCopy'
import type { PhiPluginComponentKind } from '../lib/phiPluginComponents'

export type PhiPluginComponentSectionItem = {
  key: string
  kind: PhiPluginComponentKind
  name: string
  description: string
  approval?: PhiPluginScriptToolDetail['approval']
  skillName?: string
}

const COMPONENT_ICONS = {
  agent: PhiIcons.entity.agent,
  skill: PhiIcons.entity.skill,
  script: PhiIcons.tool.command
}

// The three component kinds intentionally share one visual body; their small metadata variants
// are easier to audit together than across nearly identical item components.
// eslint-disable-next-line complexity
function ComponentItemBody({
  component,
  showDisclosure
}: {
  component: PhiPluginComponentSectionItem
  showDisclosure: boolean
}): React.JSX.Element {
  useUiLanguage()

  const Icon = COMPONENT_ICONS[component.kind]
  const descriptionLines = component.kind === 'skill' ? 3 : component.kind === 'script' ? 2 : null
  return (
    <>
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
        {component.description ? (
          <Typography
            component="span"
            variant="body2"
            color="text.secondary"
            data-phi-description-truncated={descriptionLines ? 'true' : undefined}
            data-phi-description-lines={descriptionLines ?? undefined}
            sx={{
              display: descriptionLines ? '-webkit-box' : 'block',
              minWidth: 0,
              overflow: descriptionLines ? 'hidden' : undefined,
              textOverflow: descriptionLines ? 'ellipsis' : undefined,
              WebkitLineClamp: descriptionLines ?? undefined,
              WebkitBoxOrient: descriptionLines ? 'vertical' : undefined
            }}
          >
            {component.description}
          </Typography>
        ) : null}
        {component.kind === 'script' && (component.approval || component.skillName) ? (
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}
          >
            {component.approval
              ? `${pluginCopy.approval}: ${pluginCopy.approvalLabels[component.approval]}`
              : ''}
            {component.approval && component.skillName ? ' · ' : ''}
            {component.skillName ? `${pluginCopy.ownerSkill}: ${component.skillName}` : ''}
          </Typography>
        ) : null}
      </Box>
      {showDisclosure ? (
        <PhiIcons.action.back size={16} sx={{ color: 'text.secondary', flexShrink: 0, mt: 0.25 }} />
      ) : null}
    </>
  )
}

function ComponentItem({
  component,
  onInspect
}: {
  component: PhiPluginComponentSectionItem
  onInspect?: () => void
}): React.JSX.Element {
  useUiLanguage()

  const sx = {
    p: 1.25,
    gap: 1.25,
    width: '100%',
    minWidth: 0,
    borderRadius: 1.5,
    textAlign: 'left',
    justifyContent: 'flex-start',
    alignItems: 'flex-start'
  } as const
  if (!onInspect) {
    return (
      <Box data-phi-plugin-component={component.key} sx={{ ...sx, display: 'flex' }}>
        <ComponentItemBody component={component} showDisclosure={false} />
      </Box>
    )
  }
  return (
    <ButtonBase
      onClick={onInspect}
      aria-label={pluginCopy.inspectComponent(
        pluginCopy.componentLabels[component.kind],
        component.name
      )}
      aria-haspopup="dialog"
      data-phi-plugin-component={component.key}
      sx={{
        ...sx,
        '&:hover': { bgcolor: 'action.hover' },
        '&.Mui-focusVisible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2
        }
      }}
    >
      <ComponentItemBody component={component} showDisclosure />
    </ButtonBase>
  )
}

export function PhiPluginComponentSections({
  components,
  onInspect
}: {
  components: readonly PhiPluginComponentSectionItem[]
  onInspect?: (component: PhiPluginComponentSectionItem) => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Stack spacing={2} data-phi-plugin-component-sections="true">
      {(['agent', 'skill', 'script'] as const).map((kind) => {
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
              {pluginCopy.componentSections[kind]}
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
                    onInspect={onInspect ? () => onInspect(component) : undefined}
                  />
                ))}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {pluginCopy.emptyComponents[kind]}
              </Typography>
            )}
          </Box>
        )
      })}
    </Stack>
  )
}
