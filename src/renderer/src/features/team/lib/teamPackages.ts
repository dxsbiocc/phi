export function packageSelectionKey(entry: { type: string; id: string }): string {
  return `${entry.type}:${entry.id}`
}
