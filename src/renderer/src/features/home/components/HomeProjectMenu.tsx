import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useState } from 'react'
import { Button, Divider, ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material'
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
  primary: { sx: { fontSize: '0.8125rem', fontWeight: 700, lineHeight: 1.4 } }
} as const

function ProjectChoice({
  project,
  selected,
  onSelect
}: {
  project: Project
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <MenuItem selected={selected} onClick={onSelect} sx={{ minWidth: 220, fontSize: '0.8125rem' }}>
      <ListItemText primary={project.name} slotProps={menuLabelSlot} />
      {selected ? (
        <PhiIcons.state.check size={16} aria-hidden="true" />
      ) : (
        <span aria-hidden="true" style={{ width: 16 }} />
      )}
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

  return (
    <>
      <Button
        size="small"
        color="inherit"
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<PhiIcons.nav.projects sx={{ fontSize: 16 }} />}
        endIcon={<PhiIcons.action.expand sx={{ fontSize: 14 }} />}
        sx={projectChipSx}
      >
        {selectedProject?.name ?? homeCopy.chooseProject}
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 1 } } }}
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
