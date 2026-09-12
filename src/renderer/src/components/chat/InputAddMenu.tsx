import {
  Box,
  IconButton,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Tooltip,
  Typography
} from '@mui/material'
import { useCallback, useMemo, type ReactNode, type Ref } from 'react'
import { PhiIcons } from '../../icons'
import {
  formatInputFileReferences,
  formatPluginPromptReference,
  formatPromptAgentReference,
  formatSkillPromptReference
} from '../../lib/inputReferences'
import type { PluginCatalogItem, PromptAgentSummary, SkillSummary } from '../../types'
import { compactComposerIconButtonSx } from './composerControlStyles'

const AddIcon = PhiIcons.action.add
const InputAgentIcon = PhiIcons.entity.agent
const InputFileIcon = PhiIcons.tool.read
const InputPluginIcon = PhiIcons.entity.plugin
const InputSkillIcon = PhiIcons.entity.skill

function InputAddGroup({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      sx={{
        '& + &': { mt: 1.25 }
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          display: 'block',
          fontSize: '0.95rem',
          fontWeight: 800,
          letterSpacing: 0,
          lineHeight: 1.35,
          px: 1.75,
          pt: 1,
          pb: 0.5
        }}
      >
        {title}
      </Typography>
      <Box sx={{ px: 0.75, pb: 0.75 }}>{children}</Box>
    </Box>
  )
}

function InputAddEmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{
        px: 1,
        py: 0.75
      }}
    >
      {children}
    </Typography>
  )
}

function InputAddMenuRow({
  icon,
  primary,
  disabled = false,
  selected = false,
  onClick
}: {
  icon: ReactNode
  primary: string
  disabled?: boolean
  selected?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <ListItemButton
      dense
      role="menuitem"
      disabled={disabled}
      selected={selected}
      onClick={onClick}
      sx={{
        borderRadius: 1.5,
        gap: 0.5,
        minHeight: 40,
        px: 1,
        py: 0.5,
        '&.Mui-selected': {
          bgcolor: 'action.hover',
          '&:hover': { bgcolor: 'action.selected' }
        }
      }}
    >
      <ListItemIcon sx={{ color: 'primary.main', minWidth: 32 }}>{icon}</ListItemIcon>
      <ListItemText
        primary={primary}
        slotProps={{
          primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 700 } }
        }}
      />
    </ListItemButton>
  )
}

export function InputAddPanel({
  panelId,
  panelRef,
  skills,
  promptAgents,
  plugins,
  onPickFiles,
  onInsertReference,
  onClose
}: {
  panelId: string
  panelRef: Ref<HTMLDivElement>
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  plugins: PluginCatalogItem[]
  onPickFiles?: () => Promise<string[]>
  onInsertReference: (reference: string) => void
  onClose: () => void
}): ReactNode {
  const enabledSkills = useMemo(() => skills.filter((skill) => !skill.disabled), [skills])
  const installedPlugins = useMemo(() => plugins.filter((plugin) => plugin.installed), [plugins])
  const insertReference = useCallback(
    (reference: string): void => {
      onClose()
      onInsertReference(reference)
    },
    [onClose, onInsertReference]
  )
  const pickFiles = useCallback(async (): Promise<void> => {
    onClose()
    const paths = (await onPickFiles?.()) ?? []
    const reference = formatInputFileReferences(paths)
    if (reference) {
      onInsertReference(reference)
    }
  }, [onClose, onInsertReference, onPickFiles])

  return (
    <Paper
      ref={panelRef}
      id={panelId}
      variant="outlined"
      role="menu"
      aria-label="添加上下文"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        bgcolor: 'background.paper',
        maxHeight: 'min(420px, calc(100vh - 220px))',
        overflowY: 'auto',
        p: 1
      }}
    >
      <InputAddGroup title="添加">
        <InputAddMenuRow
          icon={<InputFileIcon fontSize="small" />}
          primary="文件和文件夹"
          selected
          disabled={!onPickFiles}
          onClick={() => void pickFiles()}
        />
      </InputAddGroup>

      <InputAddGroup title="智能体">
        {promptAgents.length > 0 ? (
          promptAgents.map((agent) => (
            <InputAddMenuRow
              key={agent.id}
              icon={<InputAgentIcon fontSize="small" />}
              primary={agent.name}
              onClick={() => insertReference(formatPromptAgentReference(agent))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无可指定智能体</InputAddEmptyState>
        )}
      </InputAddGroup>

      <InputAddGroup title="Skill">
        {enabledSkills.length > 0 ? (
          enabledSkills.map((skill) => (
            <InputAddMenuRow
              key={skill.id}
              icon={<InputSkillIcon fontSize="small" />}
              primary={skill.name}
              onClick={() => insertReference(formatSkillPromptReference(skill))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无可引用 Skill</InputAddEmptyState>
        )}
      </InputAddGroup>

      <InputAddGroup title="插件">
        {installedPlugins.length > 0 ? (
          installedPlugins.map((plugin) => (
            <InputAddMenuRow
              key={plugin.id}
              icon={<InputPluginIcon fontSize="small" />}
              primary={plugin.name}
              onClick={() => insertReference(formatPluginPromptReference(plugin))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无已安装插件</InputAddEmptyState>
        )}
      </InputAddGroup>
    </Paper>
  )
}

export function InputAddControl({
  open,
  controls,
  buttonRef,
  onToggle
}: {
  open: boolean
  controls: string
  buttonRef: Ref<HTMLButtonElement>
  onToggle: () => void
}): ReactNode {
  return (
    <Tooltip title="添加文件、智能体、Skill 或插件" enterDelay={400}>
      <IconButton
        ref={buttonRef}
        size="small"
        type="button"
        aria-label="添加文件、智能体、Skill 或插件"
        aria-controls={open ? controls : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={onToggle}
        sx={{
          ...compactComposerIconButtonSx,
          color: open ? 'primary.main' : 'text.secondary',
          bgcolor: open ? 'action.hover' : 'transparent',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        <AddIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  )
}
