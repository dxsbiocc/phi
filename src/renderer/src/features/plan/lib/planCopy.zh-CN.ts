import type { planEnglish } from './planCopy.en'

export const planChinese = {
  sessionModeMenuLabel: '工作模式',
  chooseSessionMode: (label: string) => `选择工作模式：${label}`,
  sessionModeAuto: '自动',
  sessionModeAutoDescription: '由智能体判断直接执行，还是先规划。',
  sessionModeAsk: '询问',
  sessionModeAskDescription: '运行命令或修改文件前，会请你批准。',
  sessionModePlan: '计划',
  sessionModePlanDescription: '只读调研并提交计划，批准后再执行。',
  sessionModePlanExecute: '规划并执行',
  sessionModePlanExecuteDescription: '规划独立步骤，批准后由执行器调度。',
  sessionModeFull: '完全访问',
  sessionModeFullDescription: '直接执行且无需审批，请谨慎使用。',
  agentSelectedPlan: (execute: boolean, reason: string) =>
    `智能体选择了：${execute ? '规划并执行' : '计划'} — ${reason}`,
  goal: '目标',
  progress: (completed: number, total: number) => `${completed}/${total} 完成`,
  runStatus: (status: 'running' | 'paused' | 'completed' | 'stopped') =>
    ({ running: '运行中', paused: '已暂停', completed: '已完成', stopped: '已停止' })[status],
  stepStatus: (
    status:
      | 'pending'
      | 'launching'
      | 'running'
      | 'unknown'
      | 'done'
      | 'failed'
      | 'skipped'
      | 'cancelled'
      | 'interrupted'
  ) =>
    ({
      pending: '待执行',
      launching: '正在启动智能体',
      running: '执行中',
      unknown: '启动状态未确认',
      done: '已完成',
      failed: '失败',
      skipped: '已跳过',
      cancelled: '已取消',
      interrupted: '已中断'
    })[status],
  unknownStepExplanation: '智能体可能仍在运行。确认安全前，不能重试、跳过、重新规划或停止。',
  missingInputs: (inputs: string) => `需要补充：${inputs}`,
  listSeparator: '、',
  accessRead: '读',
  accessWrite: '写',
  attempts: (count: number) => `尝试 ${count} 次`,
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  retry: '重试',
  skip: '跳过',
  replanRemaining: '重新规划剩余步骤',
  replanSendFailed: '无法发送重新规划请求。请在当前会话中重试。',
  replanCancelFailed:
    '无法清除待处理的重新规划请求。如果请求已出现在聊天中，请在那里继续；否则请重试取消，再重新规划。',
  retryCancellation: '重试取消',
  confirmStopTitle: '停止这个计划？',
  confirmStopBody: '停止整个计划后无法撤销。',
  confirmSkipTitle: '跳过这一步？',
  confirmSkipBody: '跳过这一步后无法撤销。依赖它的步骤可能在缺少该结果的情况下继续。',
  confirmRetryTitle: '重试这个写入步骤？',
  confirmRetryBody: '这一步可能已经修改文件。再次执行前请先检查工作区。',
  confirm: '确认',
  cancel: '取消',
  report: '报告',
  error: '错误',
  loading: '正在加载…',
  loadFailed: '无法加载计划详情。',
  planRunCompleted: (goal: string) => `计划已完成：${goal}`,
  planRunStopped: (goal: string) => `计划已停止：${goal}`,
  expandStep: (title: string) => `展开步骤“${title}”`,
  collapseStep: (title: string) => `收起步骤“${title}”`,
  collapseSummary: '收起计划摘要',
  expandSummary: '展开计划摘要',
  awaitingReview: '等待评审',
  approvedToExecute: '已批准执行',
  changesRequested: '需要修改',
  cancelled: '已取消',
  planReviewHistory: '计划评审记录',
  viewPlanDetails: '查看计划详情',
  plan: '计划 ·',
  revisionNotes: '修改意见：',
  planAwaitingReview: '计划等待评审',
  planAwaitingReviewTitle: '计划等待评审 ·',
  revisionPlaceholder: '需要修改时，写下调整意见',
  planRevisionNotes: '计划修改意见',
  revisePlan: '修改',
  approveAndStartExecution: '批准',
  read: '读',
  write: '写',
  dependencies: (stepNumbers: string) => `依赖第 ${stepNumbers} 步`,
  agent: (name: string) => `智能体：${name}`,
  stepDetails: '说明与完成标准',
  expandStepDetails: (title: string) => `展开“${title}”的说明与完成标准`,
  instructions: '说明',
  acceptanceCriteria: '完成标准'
} satisfies typeof planEnglish
