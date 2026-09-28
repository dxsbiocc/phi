import {
  Box,
  ButtonBase,
  ClickAwayListener,
  Paper,
  Popper,
  Tooltip,
  Typography
} from '@mui/material'
import { memo, useEffect, useState, type ReactNode } from 'react'
import { PhiIcons, type PhiIconComponent } from '../../icons'
import {
  isClosedTodoTask,
  todoProgress,
  todoStatusLabel,
  type TodoProgress
} from '../../lib/todoPanel'
import type { TodoPhaseSnapshot, TodoSnapshot, TodoTaskSnapshot } from '../../lib/todoTypes'
import { useHoverIntent } from './useHoverIntent'

const TodoIcon = PhiIcons.entity.todo

const STATUS_ICON: Record<TodoTaskSnapshot['status'], PhiIconComponent> = {
  pending: PhiIcons.state.pending,
  in_progress: PhiIcons.state.inProgress,
  completed: PhiIcons.state.done,
  abandoned: PhiIcons.state.abandoned,
  blocked: PhiIcons.state.blocked
}

const STATUS_COLOR: Record<TodoTaskSnapshot['status'], string> = {
  pending: 'text.disabled',
  in_progress: 'primary.main',
  completed: 'success.main',
  abandoned: 'text.disabled',
  blocked: 'warning.main'
}

function todoTaskTooltip(task: TodoTaskSnapshot): string {
  return task.status === 'blocked' && task.blocker
    ? `阻塞：${task.blocker}`
    : todoStatusLabel(task.status)
}

function TodoTaskRow({ task }: { task: TodoTaskSnapshot }): ReactNode {
  const StatusIcon = STATUS_ICON[task.status]
  const closed = isClosedTodoTask(task)

  return (
    <Tooltip title={todoTaskTooltip(task)} enterDelay={400} placement="left">
      <Box
        component="li"
        sx={{
          listStyle: 'none',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 0.75,
          minWidth: 0
        }}
      >
        <StatusIcon
          sx={{
            fontSize: 14,
            mt: '3px',
            flexShrink: 0,
            color: STATUS_COLOR[task.status],
            '@media (prefers-reduced-motion: no-preference)': {
              animation:
                task.status === 'in_progress' ? 'phi-todo-spin 1.1s linear infinite' : 'none'
            }
          }}
        />
        <Typography
          variant="body2"
          sx={{
            minWidth: 0,
            overflowWrap: 'anywhere',
            color: closed ? 'text.disabled' : 'text.primary',
            textDecoration: closed ? 'line-through' : 'none',
            fontWeight: task.status === 'in_progress' ? 600 : 400
          }}
        >
          {task.content}
        </Typography>
      </Box>
    </Tooltip>
  )
}

function TodoPhaseSection({
  phase,
  showHeader
}: {
  phase: TodoPhaseSnapshot
  showHeader: boolean
}): ReactNode {
  if (phase.tasks.length === 0) return null
  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      {showHeader ? (
        <Typography
          variant="caption"
          component="div"
          sx={{ px: 1, pt: 1, pb: 0.25, color: 'text.secondary', fontWeight: 600 }}
        >
          {phase.name}
        </Typography>
      ) : null}
      <Box
        component="ul"
        sx={{ m: 0, p: 0, px: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}
      >
        {phase.tasks.map((task, index) => (
          // Task content is the stablest identity the tool exposes; ops rewrite phases wholesale.
          <TodoTaskRow key={`${phase.name}-${index}-${task.content}`} task={task} />
        ))}
      </Box>
    </Box>
  )
}

function pillLabel(progress: TodoProgress): string {
  const base = `${progress.completed}/${progress.total}`
  return progress.currentTask ? `${base} · ${progress.currentTask.content}` : base
}

type TodoStepPanelProps = {
  snapshot: TodoSnapshot | undefined
}

/**
 * A small pill over the chat's top-right corner (below AgentRunsOverview) showing progress
 * through the main agent's current todo list. Resting the pointer on it, or clicking it, opens
 * the full checklist grouped by phase. Renders nothing while there is no todo list yet.
 */
function TodoStepPanel({ snapshot }: TodoStepPanelProps): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [pinned, setPinned] = useState(false)
  const hover = useHoverIntent({ openDelayMs: 120, closeDelayMs: 220 })
  const progress = snapshot ? todoProgress(snapshot) : undefined
  const open = (hover.hovering || pinned) && !!progress && progress.total > 0
  const { reset: resetHover } = hover

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPinned(false)
      resetHover()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, resetHover])

  if (!snapshot || !progress || progress.total === 0) return null

  const close = (): void => {
    setPinned(false)
    resetHover()
  }

  const allDone = progress.completed === progress.total

  return (
    <ClickAwayListener onClickAway={close}>
      <Box sx={{ display: 'contents' }}>
        <style>{'@keyframes phi-todo-spin { to { transform: rotate(360deg) } }'}</style>
        <ButtonBase
          ref={setAnchor}
          onMouseEnter={hover.onEnter}
          onMouseLeave={hover.onLeave}
          onClick={() => {
            if (pinned) {
              close()
              return
            }
            setPinned(true)
          }}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`任务清单，已完成 ${pillLabel(progress)}，查看详情`}
          sx={{
            position: 'absolute',
            top: 52,
            right: 16,
            zIndex: 3,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            height: 28,
            maxWidth: 260,
            px: 1.25,
            borderRadius: 14,
            color: 'text.primary',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: open ? 'primary.main' : 'divider',
            boxShadow: 1,
            '&:hover': { borderColor: 'primary.main' },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          <TodoIcon
            sx={{ fontSize: 14, flexShrink: 0, color: allDone ? 'success.main' : 'primary.main' }}
          />
          <Typography
            variant="caption"
            noWrap
            sx={{ fontWeight: 600, lineHeight: 1, minWidth: 0 }}
            title={pillLabel(progress)}
          >
            {pillLabel(progress)}
          </Typography>
        </ButtonBase>
        <Popper
          open={open}
          anchorEl={anchor}
          placement="bottom-end"
          disablePortal
          modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}
          sx={{ zIndex: 4 }}
        >
          <Paper
            elevation={8}
            onMouseEnter={hover.onEnter}
            onMouseLeave={hover.onLeave}
            sx={{
              width: 'min(360px, calc(100vw - 32px))',
              maxHeight: '60vh',
              py: 0.75,
              overflowY: 'auto'
            }}
          >
            <Typography
              variant="caption"
              component="div"
              sx={{ px: 1.75, pb: 0.5, color: 'text.secondary', fontWeight: 600 }}
            >
              任务清单 · {progress.completed}/{progress.total}
            </Typography>
            <Box component="ul" sx={{ m: 0, p: 0, display: 'flex', flexDirection: 'column' }}>
              {snapshot.phases.map((phase) => (
                <TodoPhaseSection
                  key={phase.name}
                  phase={phase}
                  showHeader={snapshot.phases.length > 1}
                />
              ))}
            </Box>
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  )
}

export default memo(TodoStepPanel)
