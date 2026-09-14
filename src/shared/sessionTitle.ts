const INPUT_FILE_REFERENCE_LABEL = '引用文件：'
const INPUT_FILE_REFERENCE_BULLET_PATTERN = /^\s*-\s*`[^`]+`\s*$/

export function messageContentTitleText(content: string | null | undefined): string {
  if (!content) return ''

  const bodyLines: string[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().startsWith(INPUT_FILE_REFERENCE_LABEL)) {
      while (
        index + 1 < lines.length &&
        INPUT_FILE_REFERENCE_BULLET_PATTERN.test(lines[index + 1])
      ) {
        index += 1
      }
      continue
    }
    bodyLines.push(line)
  }

  return bodyLines.join('\n').replace(/\s+/g, ' ').trim()
}
