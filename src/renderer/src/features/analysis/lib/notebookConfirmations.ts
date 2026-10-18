import { analysisCopy } from './analysisUiCopy'
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
    analysisCopy.confirmSwitchKernel,
    '',
    analysisCopy.currentKernel(currentKernelLabel),
    analysisCopy.nextKernel(nextKernelLabel),
    ''
  ]

  lines.push(
    hasCurrentLiveSession ? analysisCopy.kernelStopWarning : analysisCopy.kernelMetadataReconnect
  )
  return lines.join('\n')
}

export function notebookAiInsertionConfirmationMessage({
  cellCount
}: {
  cellCount: number
}): string {
  return [
    analysisCopy.confirmInsertAi,
    '',
    analysisCopy.insertCellConfirmation(cellCount),
    analysisCopy.confirmNotebookEditable
  ].join('\n')
}
