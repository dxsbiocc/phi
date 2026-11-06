import { defineCopy } from '../../../lib/i18n'

export const chatCodeCopy = defineCopy(
  {
    run: 'Run',
    createNotebook: 'Create Notebook',
    runInBackground: 'Run Bash in the background?',
    workingDirectory: 'Working directory',
    resultDestination: 'Phi will return the result to this conversation so the agent can continue.',
    cancel: 'Cancel',
    startFailed: 'Could not start the background command',
    shellQueued: 'Bash command queued',
    shellRunning: 'Bash command running',
    shellCompleted: 'Bash command completed',
    shellFailed: 'Bash command failed',
    shellCancelled: 'Bash command cancelled',
    shellInterrupted: 'Bash command interrupted',
    exitCode: (code: number) => `Exit code ${code}`,
    outputTruncated: 'The output exceeded the capture limit.',
    showOutput: 'Show captured output',
    loadingOutput: 'Loading output…',
    outputUnavailable: 'Could not load the captured output.'
  },
  {
    run: '运行',
    createNotebook: '创建 Notebook',
    runInBackground: '在后台运行 Bash 命令？',
    workingDirectory: '工作目录',
    resultDestination: 'Phi 会把运行结果发回此对话，供助手继续处理。',
    cancel: '取消',
    startFailed: '无法启动后台命令',
    shellQueued: 'Bash 命令已排队',
    shellRunning: 'Bash 命令运行中',
    shellCompleted: 'Bash 命令已完成',
    shellFailed: 'Bash 命令失败',
    shellCancelled: 'Bash 命令已取消',
    shellInterrupted: 'Bash 命令已中断',
    exitCode: (code: number) => `退出码 ${code}`,
    outputTruncated: '输出超出记录上限。',
    showOutput: '查看已记录的输出',
    loadingOutput: '正在读取输出…',
    outputUnavailable: '无法读取已记录的输出。'
  }
)
