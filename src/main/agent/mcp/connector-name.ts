export function validateName(name: string): string {
  if (typeof name !== 'string') throw new Error('Invalid Connector name')
  const trimmed = name.trim()
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(trimmed)) {
    throw new Error(
      'Connector names must contain 2–64 letters, numbers, underscores or hyphens, starting with a letter'
    )
  }
  return trimmed
}
