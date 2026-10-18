import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Badge, Chip, IconButton } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { TbCode, TbFile, TbPackage, TbTable, TbVariable } from 'react-icons/tb'
import { PhiIcons } from '../../icons'
import { ResourceIcon } from '../ResourceIcon'
import type { InlineComposerReference } from '../../lib/composerReferences'
import { resourceCatalogCopy, resourceUi } from '../../lib/resourceUi'

const WebIcon = PhiIcons.tool.web
const RemoveIcon = PhiIcons.action.close
const LABELS = {
  get skill() {
    return resourceUi.skill
  },
  get agent() {
    return chatCopy.agent
  },
  get wrapper() {
    return resourceUi.wrapper
  },
  get mcp() {
    return resourceUi.connector
  },
  get plugin() {
    return resourceUi.plugin
  },
  get web() {
    return chatCopy.webLink
  },
  get module() {
    return chatCopy.module
  },
  get variable() {
    return chatCopy.variable
  },
  get dataframe() {
    return chatCopy.dataframe
  },
  get data_source() {
    return chatCopy.dataSource
  },
  get cell_output() {
    return chatCopy.cellOutput
  }
}
const TONES = {
  skill: 'primary',
  agent: 'secondary',
  wrapper: 'warning',
  mcp: 'info',
  plugin: 'error',
  web: 'neutral',
  module: 'secondary',
  variable: 'primary',
  dataframe: 'info',
  data_source: 'warning',
  cell_output: 'success'
} as const

function referenceIcon(
  reference: Pick<InlineComposerReference, 'kind' | 'icon'>
): React.JSX.Element {
  switch (reference.kind) {
    case 'module':
      return <TbPackage />
    case 'variable':
      return <TbVariable />
    case 'dataframe':
      return <TbTable />
    case 'data_source':
      return <TbFile />
    case 'cell_output':
      return <TbCode />
    case 'web':
      return <WebIcon />
    default:
      return (
        <ResourceIcon
          component="span"
          kind={reference.kind}
          icon={reference.icon}
          size={18}
          sx={{ ml: 0.75, mr: 0.25, color: 'inherit' }}
        />
      )
  }
}

export function ComposerReferenceChip({
  reference,
  onRemove,
  disabled = false
}: {
  reference: Pick<InlineComposerReference, 'kind' | 'id' | 'name' | 'text' | 'icon' | 'onOpen'>
  onRemove: () => void
  disabled?: boolean
}): React.JSX.Element {
  useUiLanguage()
  const label = LABELS[reference.kind]
  const resourceReference = ['skill', 'wrapper', 'mcp', 'plugin'].includes(reference.kind)
  const removeLabel = resourceReference
    ? resourceCatalogCopy.removeReference(label, reference.name)
    : chatCopy.removeValueReferenceValue(label, reference.name)
  return (
    <Badge
      data-phi-reference-badge={reference.kind}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      overlap="rectangular"
      badgeContent={
        disabled ? undefined : (
          <IconButton
            type="button"
            size="small"
            data-phi-reference-remove={reference.kind}
            aria-label={removeLabel}
            title={removeLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            sx={{
              width: 18,
              height: 18,
              p: 0,
              borderRadius: '50%',
              bgcolor: 'text.secondary',
              color: 'background.paper',
              boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}`,
              '&:hover': { bgcolor: 'text.primary' }
            }}
          >
            <RemoveIcon size={12} />
          </IconButton>
        )
      }
      sx={{
        maxWidth: '100%',
        verticalAlign: 'middle',
        '& .MuiBadge-badge': {
          minWidth: 0,
          width: 18,
          height: 18,
          p: 0,
          transform: 'translate(35%, -35%)',
          opacity: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
          transition: 'opacity 100ms ease'
        },
        '&:hover .MuiBadge-badge, &:focus-within .MuiBadge-badge': {
          opacity: 1,
          visibility: 'visible',
          pointerEvents: 'auto'
        },
        '@media (hover: none)': {
          '& .MuiBadge-badge': { opacity: 1, visibility: 'visible', pointerEvents: 'auto' }
        }
      }}
    >
      <Chip
        data-phi-reference-kind={reference.kind}
        icon={referenceIcon(reference)}
        label={reference.name}
        variant="filled"
        onClick={disabled ? undefined : reference.onOpen}
        title={reference.text}
        onDelete={disabled ? undefined : onRemove}
        deleteIcon={<span />}
        aria-label={
          resourceReference && reference.onOpen
            ? resourceCatalogCopy.viewReference(label, reference.name)
            : chatCopy.viewReference(label, reference.name, Boolean(reference.onOpen))
        }
        sx={(theme) => {
          const tone = TONES[reference.kind]
          const palette = tone === 'neutral' ? null : theme.palette[tone]
          const dark = theme.palette.mode === 'dark'
          const accent = palette?.main ?? theme.palette.text.secondary
          const foreground = palette
            ? dark
              ? palette.light
              : palette.dark
            : theme.palette.text.secondary
          return {
            height: 26,
            maxWidth: '100%',
            borderRadius: 1.25,
            border: 0,
            bgcolor: alpha(accent, dark ? 0.18 : 0.1),
            color: foreground,
            fontWeight: 700,
            fontSize: '0.9rem',
            lineHeight: 1.25,
            verticalAlign: 'middle',
            '&:hover, &.MuiChip-clickable:hover, &.Mui-focusVisible': {
              bgcolor: alpha(accent, dark ? 0.28 : 0.18)
            },
            '& .MuiChip-icon': { color: 'inherit', fontSize: 18, ml: 0.75, mr: 0.25 },
            '& .MuiChip-label': {
              minWidth: 0,
              px: 0.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            },
            '& .MuiChip-deleteIcon': { display: 'none' }
          }
        }}
      />
    </Badge>
  )
}
