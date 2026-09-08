const SAVED_OUTPUT_MARKER = /\n?\.{3}（完整输出已保存到 .+）\s*$/s

export const INLINE_OUTPUT_PREVIEW_CHARS = 12000
export const PERSISTED_OUTPUT_PREVIEW_CHARS = 1600
export const TOOL_ARGS_PREVIEW_CHARS = 4000

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`
  const mib = kib / 1024
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`
}

export function stripSavedOutputMarker(output: string): string {
  return output.replace(SAVED_OUTPUT_MARKER, '').trimEnd()
}

function truncatePreviewText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n...（预览已截断）`
}

export function outputPreviewText({
  output,
  outputPath,
  outputTruncated
}: {
  output: string
  outputPath?: string
  outputTruncated?: boolean
}): string {
  const cleanOutput = outputTruncated && outputPath ? stripSavedOutputMarker(output) : output
  const limit =
    outputTruncated && outputPath ? PERSISTED_OUTPUT_PREVIEW_CHARS : INLINE_OUTPUT_PREVIEW_CHARS
  return truncatePreviewText(cleanOutput, limit)
}

export function isOutputPreviewTruncated({
  output,
  outputPath,
  outputTruncated
}: {
  output: string
  outputPath?: string
  outputTruncated?: boolean
}): boolean {
  const cleanOutput = outputTruncated && outputPath ? stripSavedOutputMarker(output) : output
  const limit =
    outputTruncated && outputPath ? PERSISTED_OUTPUT_PREVIEW_CHARS : INLINE_OUTPUT_PREVIEW_CHARS
  return cleanOutput.length > limit
}

export function toolArgsPreviewText(argsJson: string): string {
  return truncatePreviewText(argsJson, TOOL_ARGS_PREVIEW_CHARS)
}

export function isToolArgsPreviewTruncated(argsJson: string): boolean {
  return argsJson.length > TOOL_ARGS_PREVIEW_CHARS
}
