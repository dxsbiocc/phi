export function diffStat(output: string): { added: number; removed: number } | null {
  const lines = output.split('\n')
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return added || removed ? { added, removed } : null
}
