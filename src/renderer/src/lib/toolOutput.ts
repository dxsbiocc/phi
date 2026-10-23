export function diffStat(output: string): { added: number; removed: number } | null {
  let added = 0
  let removed = 0
  let hasOldFileHeader = false
  let hasFileHeaders = false
  let oldLinesLeft = 0
  let newLinesLeft = 0
  let hunkAdded = 0
  let hunkRemoved = 0
  let inHunk = false

  for (const line of output.split(/\r?\n/)) {
    if (inHunk) {
      if (line.startsWith('\\ No newline at end of file')) continue

      if (line.startsWith(' ')) {
        oldLinesLeft -= 1
        newLinesLeft -= 1
      } else if (line.startsWith('+')) {
        newLinesLeft -= 1
        hunkAdded += 1
      } else if (line.startsWith('-')) {
        oldLinesLeft -= 1
        hunkRemoved += 1
      } else {
        inHunk = false
      }

      if (inHunk && oldLinesLeft >= 0 && newLinesLeft >= 0) {
        if (oldLinesLeft === 0 && newLinesLeft === 0) {
          added += hunkAdded
          removed += hunkRemoved
          inHunk = false
        }
        continue
      }
      inHunk = false
    }

    if (line.startsWith('--- ')) {
      hasOldFileHeader = true
      hasFileHeaders = false
      continue
    }
    if (line.startsWith('+++ ')) {
      hasFileHeaders = hasOldFileHeader
      continue
    }

    const hunk = hasFileHeaders ? /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line) : null
    if (!hunk) continue
    oldLinesLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
    newLinesLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
    hunkAdded = 0
    hunkRemoved = 0
    inHunk = oldLinesLeft + newLinesLeft > 0
  }
  return added || removed ? { added, removed } : null
}
