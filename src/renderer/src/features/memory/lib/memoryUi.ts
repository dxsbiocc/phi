import { defineCopy } from '../../../lib/i18n'

/** Fixed interface copy; resource names, user input, and protocol values stay untouched. */
export const memoryUi = defineCopy(
  {
    lessonsCount: (count: number) => `Agent lessons (${count})`,
    memory: 'Memory',
    withProjectMemoryEnabledPhiSummarizesCompletedProject:
      'With project memory enabled, Phi summarizes completed project conversations in the background using the current session model and provides the summary to future sessions. Summaries are stored only on this computer, including for remote projects. This setting applies to new sessions.',
    allowingTheAgentToRecordLessonsLetsIt:
      'Allowing the agent to record lessons lets it save project conventions and useful fixes while working. You can review and delete each lesson here.',
    noProjectsYet: 'No projects yet',
    remoteProject: 'Remote project',
    localProject: 'Local project',
    collapse: 'Collapse',
    viewMemory: 'View memory',
    projectMemory: 'Project memory',
    allowTheAgentToRecordLessons: 'Allow the agent to record lessons',
    noMemoryYetWhenEnabledPhiGeneratesA:
      'No memory yet. When enabled, Phi generates a summary in the background when you create a new session after project conversations have finished and been idle for a while.',
    conversationSummary: 'Conversation summary',
    updatedValue: (value0: unknown) => ` · Updated ${value0}`,
    deleteThisLesson: 'Delete this lesson',
    clearingMemoryExcludesExistingConversationsFromFutureSummaries:
      'Clearing memory excludes existing conversations from future summaries. Only later conversations will create new memory.',
    cancel: 'Cancel',
    confirmClear: 'Confirm clear',
    clearMemory: 'Clear memory'
  },
  {
    lessonsCount: (count: number) => `agent 记录的经验（${count}）`,
    memory: '记忆',
    withProjectMemoryEnabledPhiSummarizesCompletedProject:
      '开启项目记忆后，Phi 会在后台用当前会话的模型总结这个项目里已结束的对话，并在之后的新会话里提供这份总结。总结只保存在这台电脑上，远程项目也一样，不会写到服务器。设置对新会话生效。',
    allowingTheAgentToRecordLessonsLetsIt:
      '“允许 agent 记录经验”会让 agent 在工作中主动记下项目约定、非显而易见的修复等经验。每条经验都可以在这里查看和删除。',
    noProjectsYet: '还没有项目',
    remoteProject: '远程项目',
    localProject: '本地项目',
    collapse: '收起',
    viewMemory: '查看记忆',
    projectMemory: '项目记忆',
    allowTheAgentToRecordLessons: '允许 agent 记录经验',
    noMemoryYetWhenEnabledPhiGeneratesA:
      '还没有记忆。开启后，项目里的对话结束并空闲一段时间，下次新建会话时会在后台生成总结。',
    conversationSummary: '对话总结',
    updatedValue: (value0: unknown) => ` · 更新于 ${value0}`,
    deleteThisLesson: '删除这条经验',
    clearingMemoryExcludesExistingConversationsFromFutureSummaries:
      '清空后，已有对话不会再被总结；只有之后的对话会形成新记忆。',
    cancel: '取消',
    confirmClear: '确认清空',
    clearMemory: '清空记忆'
  }
)
