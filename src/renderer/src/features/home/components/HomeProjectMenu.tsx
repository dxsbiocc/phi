import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useState } from 'react'
import {
  Box,
  Button,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import type { Project } from '../../../types'

const projectChipSx = {
  minHeight: 36,
  px: 1.25,
  color: 'text.secondary',
  textTransform: 'none',
  bgcolor: 'background.paper',
  border: 1,
  borderColor: 'divider',
  borderRadius: 999,
  boxShadow: 1,
  '&:hover': { bgcolor: 'action.hover' }
} as const

const menuLabelSlot = {
  primary: {
    sx: {
      fontSize: '0.8125rem',
      fontWeight: 700,
      lineHeight: 1.4,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }
} as const

function projectServerLabel(project: Project): string | null {
  return project.location.kind === 'ssh'
    ? (project.remoteHostAlias ?? homeCopy.serverUnavailable)
    : null
}

function ProjectChoice({
  project,
  selected,
  onSelect
}: {
  project: Project
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const isRemote = project.location.kind === 'ssh'
  const ProjectIcon = isRemote ? PhiIcons.settings.remoteExecution : PhiIcons.entity.folder
  const serverLabel = projectServerLabel(project)

  return (
    <MenuItem selected={selected} onClick={onSelect} sx={{ fontSize: '0.8125rem' }}>
      <ListItemIcon sx={{ minWidth: 32, color: 'text.secondary' }}>
        <ProjectIcon size={18} aria-hidden="true" />
      </ListItemIcon>
      <ListItemText primary={project.name} slotProps={menuLabelSlot} sx={{ minWidth: 0 }} />
      {serverLabel ? (
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          title={serverLabel}
          sx={{ maxWidth: 88, ml: 0.75, flexShrink: 1 }}
        >
          {serverLabel}
        </Typography>
      ) : null}
    </MenuItem>
  )
}

export function HomeProjectMenu({
  projects,
  selectedProject,
  disabled,
  onSelectProject,
  onNewProject
}: {
  projects: Project[]
  selectedProject: Project | null
  disabled: boolean
  onSelectProject: (projectId: string | null) => void
  onNewProject: () => void
}): React.JSX.Element {
  useUiLanguage()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const close = (): void => setAnchor(null)
  const SelectedProjectIcon =
    selectedProject?.location.kind === 'ssh'
      ? PhiIcons.settings.remoteExecution
      : selectedProject
        ? PhiIcons.entity.folder
        : PhiIcons.nav.projects
  const selectedServerLabel = selectedProject ? projectServerLabel(selectedProject) : null
  const selectedProjectTitle = selectedProject
    ? `${selectedProject.name}${selectedServerLabel ? ` · ${selectedServerLabel}` : ''}`
    : undefined

  return (
    <>
      <Button
        size="small"
        color="inherit"
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        title={selectedProjectTitle}
        aria-label={selectedServerLabel ? selectedProjectTitle : undefined}
        startIcon={<SelectedProjectIcon sx={{ fontSize: 16 }} />}
        endIcon={<PhiIcons.action.expand sx={{ fontSize: 14 }} />}
        sx={{ ...projectChipSx, maxWidth: 220 }}
      >
        <Box
          component="span"
          sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {selectedProject?.name ?? homeCopy.chooseProject}
        </Box>
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 1, width: 256, maxWidth: 'calc(100vw - 24px)' } } }}
      >
        {projects.map((project) => (
          <ProjectChoice
            key={project.id}
            project={project}
            selected={project.id === selectedProject?.id}
            onSelect={() => {
              onSelectProject(project.id)
              close()
            }}
          />
        ))}
        {projects.length > 0 ? <Divider /> : null}
        <MenuItem
          onClick={() => {
            close()
            onNewProject()
          }}
        >
          <ListItemIcon sx={{ minWidth: 28 }}>
            <PhiIcons.action.add size={16} />
          </ListItemIcon>
          <ListItemText primary={homeCopy.newProject} slotProps={menuLabelSlot} />
        </MenuItem>
      </Menu>
    </>
  )
}
