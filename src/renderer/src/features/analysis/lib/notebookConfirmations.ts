export function notebookKernelSwitchConfirmationMessage({
  currentKernelLabel,
  nextKernelLabel,
  hasCurrentLiveSession
}: {
  currentKernelLabel: string
  nextKernelLabel: string
  hasCurrentLiveSession: boolean
}): string {
  const lines = [
    '确认切换 notebook kernel？',
    '',
    `当前：${currentKernelLabel}`,
    `切换到：${nextKernelLabel}`,
    ''
  ]

  lines.push(
    hasCurrentLiveSession
      ? '当前连接的 kernel 会被终止，正在运行的 cell 会停止。'
      : 'Notebook 的 kernel metadata 会更新，并尝试连接新 kernel。'
  )
  return lines.join('\n')
}

export function notebookAiInsertionConfirmationMessage({
  cellCount
}: {
  cellCount: number
}): string {
  return [
    '确认将 AI 生成内容插入 notebook？',
    '',
    `将插入 ${cellCount} 个 cell，并立即保存到当前 .ipynb 文件。`,
    '请确认当前 notebook 内容可以被修改。'
  ].join('\n')
}
