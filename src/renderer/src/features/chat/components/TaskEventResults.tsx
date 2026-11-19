import { Box, Button, IconButton, Paper, Stack, Typography } from '@mui/material'
import type { TaskEventNotice, TaskEventTask } from '../../../../../shared/taskEventTypes'
import { PhiIcons } from '../../../icons'
import { defineCopy, useUiLanguage } from '../../../lib/i18n'

const copy = defineCopy(
  {
    region: 'Task replies',
    list: 'Recent tasks',
    status: 'Task status',
    clarify: {
      syntax: 'Use a task command with the required arguments.',
      'missing-target': 'Which task do you mean? Include its ID.',
      ambiguous: 'Several tasks share this prefix. Use the full task ID.',
      'not-found': 'No task matches that ID. Use /tasks to find it.',
      attachments: 'Task controls use text only. Your attachments are still in the composer.'
    },
    statuses: {
      queued: 'Queued',
      running: 'Running',
      needs_approval: 'Waiting for approval',
      succeeded: 'Completed',
      cancelled: 'Cancelled',
      failed: 'Failed',
      interrupted: 'Interrupted'
    },
    commands:
      'Use /task status, /task cancel, /task approve, /task deny or /task add, followed by the task ID. Add the new instruction after /task add.',
    none: 'No matching tasks.',
    more: 'More tasks are available in Background Tasks.',
    close: 'Dismiss task reply',
    removed: 'Removed from the queue.',
    stopping: 'Stop requested. Check task status for the outcome.',
    unavailable:
      'The task or approval is no longer available for this action. Check its status and try again.',
    approval: 'Review the tool request',
    noApproval: 'This task has no pending tool approval.',
    approve: 'Approve this request',
    deny: 'Deny this request',
    approved: 'Approval sent.',
    denied: 'Denial sent.',
    supplemented: 'Follow-up queued in the original chat.',
    followUpTo: 'Follow-up to'
  },
  {
    region: '任务回复',
    list: '近期任务',
    status: '任务状态',
    clarify: {
      syntax: '请按格式填写任务指令。',
      'missing-target': '你指的是哪个任务？请附上任务 ID。',
      ambiguous: '有多个任务使用这个前缀，请填写完整任务 ID。',
      'not-found': '找不到该任务。用 /tasks 查看任务 ID。',
      attachments: '任务控制指令只接收文本，附件已保留在输入框中。'
    },
    statuses: {
      queued: '排队中',
      running: '运行中',
      needs_approval: '待审批',
      succeeded: '已完成',
      cancelled: '已取消',
      failed: '失败',
      interrupted: '已中断'
    },
    commands:
      '在 /task status、/task cancel、/task approve、/task deny 或 /task add 后输入任务 ID。用 /task add 时再输入补充内容。',
    none: '没有匹配的任务。',
    more: '可在后台任务面板查看其他任务。',
    close: '关闭任务回复',
    removed: '已取消排队。',
    stopping: '已发出停止请求。可查询任务状态确认结果。',
    unavailable: '当前任务或审批无法执行此操作，请查看状态后重试。',
    approval: '查看工具审批请求',
    noApproval: '此任务没有待处理的工具审批。',
    approve: '批准此请求',
    deny: '拒绝此请求',
    approved: '已提交批准。',
    denied: '已提交拒绝。',
    supplemented: '补充内容已在原会话排队。',
    followUpTo: '补充任务'
  }
)

export interface TaskEventReply {
  key: string
  notice: TaskEventNotice
}

interface Props {
  replies: readonly TaskEventReply[]
  onDismiss(key: string): void
  onDecide(key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void
}

function TaskRow({ task }: { task: TaskEventTask }): React.JSX.Element {
  return (
    <Box data-phi-task-event-id={task.id} sx={{ overflowWrap: 'anywhere' }}>
      <Typography component="div" variant="body2">
        {[task.title, task.preview, copy.statuses[task.status]].filter(Boolean).join(' · ')}
      </Typography>
      <Typography
        component="code"
        variant="caption"
        color="text.secondary"
        sx={{ userSelect: 'text' }}
      >
        {task.id}
      </Typography>
      {task.supplementTo && (
        <Typography component="div" variant="caption" color="text.secondary">
          {copy.followUpTo} <code>{task.supplementTo}</code>
        </Typography>
      )}
    </Box>
  )
}

function heading(notice: TaskEventNotice): string {
  switch (notice.kind) {
    case 'list':
      return copy.list
    case 'status':
      return copy.status
    case 'clarify':
      return copy.clarify[notice.reason]
    case 'cancelled':
      return copy.removed
    case 'stopping':
      return copy.stopping
    case 'unavailable':
      return copy.unavailable
    case 'approval':
      return copy.approval
    case 'decided':
      return notice.action === 'approve' ? copy.approved : copy.denied
    case 'supplemented':
      return copy.supplemented
  }
}

export function TaskEventResults({
  replies,
  onDismiss,
  onDecide
}: Props): React.JSX.Element | null {
  useUiLanguage()
  if (!replies.length) return null
  return (
    <Stack
      role="region"
      aria-label={copy.region}
      spacing={1}
      sx={{ mb: 1, maxHeight: 280, overflow: 'auto' }}
    >
      {replies.map(({ key, notice }) => (
        <Paper
          key={key}
          data-phi-task-event-result={notice.kind}
          variant="outlined"
          sx={{ p: 1.25 }}
        >
          <Stack
            direction="row"
            sx={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}
          >
            <Typography variant="body2" role="status" sx={{ fontWeight: 600 }}>
              {heading(notice)}
            </Typography>
            <IconButton
              type="button"
              size="small"
              aria-label={copy.close}
              onClick={() => onDismiss(key)}
            >
              <PhiIcons.action.close size={14} />
            </IconButton>
          </Stack>
          {'task' in notice && <TaskRow task={notice.task} />}
          {(notice.kind === 'list' || notice.kind === 'clarify') && (
            <Stack spacing={0.5}>
              {notice.tasks?.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              {notice.tasks?.length === 0 && <Typography variant="caption">{copy.none}</Typography>}
              {notice.more && <Typography variant="caption">{copy.more}</Typography>}
              {notice.kind === 'list' || notice.reason !== 'attachments' ? (
                <Typography variant="caption" color="text.secondary">
                  {copy.commands}
                </Typography>
              ) : null}
            </Stack>
          )}
          {notice.kind === 'supplemented' && (
            <Typography component="code" variant="caption" sx={{ userSelect: 'text' }}>
              {notice.id}
            </Typography>
          )}
          {notice.kind === 'approval' && (
            <Stack spacing={1}>
              {notice.requests.length === 0 && (
                <Typography variant="body2">{copy.noApproval}</Typography>
              )}
              {notice.requests.map((request) => (
                <Box key={request.id}>
                  <Typography variant="subtitle2">{request.tool}</Typography>
                  <Typography
                    component="pre"
                    variant="body2"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      userSelect: 'text',
                      my: 0.5
                    }}
                  >
                    {request.summary}
                  </Typography>
                  <Button
                    type="button"
                    size="small"
                    variant="outlined"
                    data-phi-task-approval-decision={request.id}
                    onClick={() => onDecide(key, notice.task.id, request.id, notice.action)}
                  >
                    {copy[notice.action]}
                  </Button>
                </Box>
              ))}
            </Stack>
          )}
        </Paper>
      ))}
    </Stack>
  )
}
