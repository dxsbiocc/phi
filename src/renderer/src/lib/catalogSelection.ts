export function retainSelectedCatalogId<T extends { id: string }>(
  current: string | null,
  entries: readonly T[]
): string | null {
  return current && entries.some((entry) => entry.id === current) ? current : null
}
