import { defineCopy } from '../../../lib/i18n'

/** App-generated event notices only; service diagnostics and user messages stay verbatim. */
export const chatEventCopy = defineCopy(
  {
    interruptedByRestart: 'The previous run was interrupted when the app restarted.',
    interrupted: 'The run was interrupted.',
    runFailed: 'The run failed.',
    remoteRunStopped: 'Stopped the unfinished previous remote run.',
    mcpLocalSkipped: (names: string) =>
      `Local connectors ${names} are unavailable in remote projects (they can only run on this Mac).`,
    mcpOthersSkipped: (list: string) => `Connectors not enabled for this conversation: ${list}.`,
    mcpReason: {
      unavailable: 'not found',
      stdio_not_allowed: 'local only',
      env_not_ready: 'environment not ready',
      profile_changed: 'configuration changed',
      api_key_missing: 'missing key',
      api_key_unavailable: 'missing key',
      prepare_failed: 'not connected',
      connect_failed: 'not connected',
      startup_failed: 'not connected',
      startup_pending: 'not connected',
      not_connected: 'not connected'
    } as Record<string, string>,
    mcpOther: (name: string, reason: string) => `${name} (${reason})`,
    mcpMore: (count: number) => `${count} more connectors are not listed.`,
    listSeparator: ', ',
    requestFailed: 'Request failed',
    contextCompacted:
      'Context compacted. Earlier content was summarized for the model; visible conversation history is preserved.',
    compactionFailure: (detail: string) =>
      `Context compaction failed${detail ? `: ${detail}` : ''}`,
    imagesRemoved: (count: string) =>
      `The SDK removed ${count} historical images from model context to continue compaction; the images remain available in conversation history.`,
    maintenanceNotice: (detail: string) => `SDK context maintenance notice: ${detail}`,
    previousModel: 'Previous model',
    availableModel: 'Available model',
    modelFallback: (from: string, to: string) => `${from} request failed. Trying ${to}.`,
    modelMigrated: (from: string, to: string) => `${from} is unavailable. Switched to ${to}.`,
    parallelWarning: (count: number) =>
      `${count} other conversations in this project are running or awaiting permission. This conversation will start; switching conversations does not interrupt background work.`,
    referencedFilesPrefix: 'Referenced files:',
    agentReference: (name: string) => `/agent:${name}`
  },
  {
    interruptedByRestart: '上次运行因应用重启而中断。',
    interrupted: '运行已中断。',
    runFailed: '运行失败。',
    remoteRunStopped: '已停止上一次未结束的远端运行。',
    mcpLocalSkipped: (names: string) =>
      `本机连接器 ${names} 在远程项目中不可用（它们只能在本机运行）。`,
    mcpOthersSkipped: (list: string) => `以下连接器本次会话未启用：${list}。`,
    mcpReason: {
      unavailable: '未找到',
      stdio_not_allowed: '仅限本机',
      env_not_ready: '环境未就绪',
      profile_changed: '配置已变化',
      api_key_missing: '缺少密钥',
      api_key_unavailable: '缺少密钥',
      prepare_failed: '未连接',
      connect_failed: '未连接',
      startup_failed: '未连接',
      startup_pending: '未连接',
      not_connected: '未连接'
    } as Record<string, string>,
    mcpOther: (name: string, reason: string) => `${name}（${reason}）`,
    mcpMore: (count: number) => `另有 ${count} 个连接器未列出。`,
    listSeparator: '、',
    requestFailed: '请求失败',
    contextCompacted: '上下文已压缩，较早内容已汇总给模型；聊天时间线会继续保留可见历史。',
    compactionFailure: (detail: string) => `上下文压缩失败${detail ? `：${detail}` : ''}`,
    imagesRemoved: (count: string) =>
      `SDK 为继续压缩，从模型上下文移除了 ${count} 张历史图片；聊天记录中的图片仍可查看。`,
    maintenanceNotice: (detail: string) => `SDK 上下文整理提示：${detail}`,
    previousModel: '旧模型',
    availableModel: '可用模型',
    modelFallback: (from: string, to: string) => `${from} 请求失败，正在尝试 ${to}。`,
    modelMigrated: (from: string, to: string) => `${from} 当前不可用，已切换到 ${to}。`,
    parallelWarning: (count: number) =>
      `这个项目里还有 ${count} 个会话正在运行或等待权限。当前会话会继续启动，切换会话不会打断后台进程。`,
    referencedFilesPrefix: '引用文件：',
    agentReference: (name: string) => `调用智能体：${name}`
  }
)
