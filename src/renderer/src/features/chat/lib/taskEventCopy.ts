import type { TaskEventNotice } from '../../../../../shared/taskEventTypes'
import { defineCopy } from '../../../lib/i18n'

export const taskEventCopy = defineCopy(
  {
    clarify: {
      syntax: 'Use a task command with the required arguments.',
      'missing-target': 'Which task do you mean? Include its ID.',
      ambiguous: 'Several tasks share this prefix. Use the full task ID.',
      'not-found': 'No task matches that ID. Use /tasks to find it.',
      attachments: 'Task controls use text only. Your attachments are still in the composer.'
    },
    commands:
      'Use /task run followed by instructions to start an independent task. Use /task status, /task cancel, /task approve, /task deny or /task add with a task ID. Add the new instruction after /task add.',
    none: 'No matching tasks.',
    more: 'See the other tasks in Background Jobs.',
    close: 'Dismiss task reply',
    removed: 'Removed from the queue.',
    cancelled: 'Task cancelled.',
    stopping: 'Stop requested.',
    unavailable: 'The task or approval is no longer available for this action.',
    approval: 'Review the tool request',
    noApproval: 'This task has no pending tool approval.',
    approve: 'Approve this request',
    deny: 'Deny this request',
    approved: 'Approval sent.',
    denied: 'Denial sent.',
    supplemented: 'Follow-up queued in the original chat.'
  },
  {
    clarify: {
      syntax: '请按格式填写任务指令。',
      'missing-target': '你指的是哪个任务？请附上任务 ID。',
      ambiguous: '有多个任务使用这个前缀，请填写完整任务 ID。',
      'not-found': '找不到该任务。用 /tasks 查看任务 ID。',
      attachments: '任务控制指令只接收文本，附件已保留在输入框中。'
    },
    commands:
      '在 /task run 后输入任务说明，即可启动独立任务。在 /task status、/task cancel、/task approve、/task deny 或 /task add 后输入任务 ID。用 /task add 时再输入补充内容。',
    none: '没有匹配的任务。',
    more: '可在后台任务面板查看其他任务。',
    close: '关闭任务回复',
    removed: '已取消排队。',
    cancelled: '任务已取消。',
    stopping: '已发出停止请求。',
    unavailable: '当前任务或审批无法执行此操作。',
    approval: '查看工具审批请求',
    noApproval: '此任务没有待处理的工具审批。',
    approve: '批准此请求',
    deny: '拒绝此请求',
    approved: '已提交批准。',
    denied: '已提交拒绝。',
    supplemented: '补充内容已在原会话排队。'
  }
)

export function taskEventFeedback(
  notice: TaskEventNotice
): { message: string; severity: 'info' | 'success' | 'warning' } | undefined {
  switch (notice.kind) {
    case 'clarify':
      return { message: taskEventCopy.clarify[notice.reason], severity: 'warning' }
    case 'cancelled':
      return {
        message: notice.task.independent ? taskEventCopy.cancelled : taskEventCopy.removed,
        severity: 'info'
      }
    case 'stopping':
      return { message: taskEventCopy.stopping, severity: 'info' }
    case 'unavailable':
      return { message: taskEventCopy.unavailable, severity: 'warning' }
    case 'decided':
      return {
        message: notice.action === 'approve' ? taskEventCopy.approved : taskEventCopy.denied,
        severity: 'success'
      }
    case 'supplemented':
      return { message: taskEventCopy.supplemented, severity: 'success' }
    default:
      return undefined
  }
}
