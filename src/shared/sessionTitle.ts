const INPUT_FILE_REFERENCE_LABEL = '引用文件：'
const INPUT_FILE_REFERENCE_BULLET_PATTERN = /^\s*-\s*`[^`]+`\s*$/

export function messageContentTitleText(content: string | null | undefined): string {
  if (!content) return ''

  // Older sessions may persist this former user-message suffix in a truncated title.
  const instructionStart = content.indexOf('<phi_next_action_instruction>')
  const visibleContent = instructionStart >= 0 ? content.slice(0, instructionStart) : content
  const bodyLines: string[] = []
  const lines = visibleContent.split(/\r?\n/)
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
