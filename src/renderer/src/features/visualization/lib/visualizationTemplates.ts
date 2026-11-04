import type {
  VisualizationTemplate,
  VisualizationTemplateGroup
} from '../../../../../shared/visualizationTemplateTypes'

export function visualizationTemplateMatches(
  template: VisualizationTemplate,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [template.title, template.id, template.variant, ...template.aliases].some((value) =>
    value?.toLowerCase().includes(normalized)
  )
}

export function filteredVisualizationGroups(
  groups: readonly VisualizationTemplateGroup[],
  query: string
): VisualizationTemplateGroup[] {
  return groups.flatMap((group) => {
    const templates = group.templates.filter((template) =>
      visualizationTemplateMatches(template, query)
    )
    return templates.length > 0 ? [{ ...group, templates }] : []
  })
}

/** `null` is the All row. A group id that the current filter removed falls back to All. */
export function selectedVisualizationGroupId(
  groups: readonly VisualizationTemplateGroup[],
  selectedGroupId: string | null
): string | null {
  if (selectedGroupId && groups.some((group) => group.id === selectedGroupId)) {
    return selectedGroupId
  }
  return null
}

export function visibleVisualizationTemplates(
  groups: readonly VisualizationTemplateGroup[],
  query: string,
  selectedGroupId: string | null
): VisualizationTemplate[] {
  const filtered = filteredVisualizationGroups(groups, query)
  const activeGroupId = selectedVisualizationGroupId(filtered, selectedGroupId)
  if (!activeGroupId) return filtered.flatMap((group) => group.templates)
  return filtered.find((group) => group.id === activeGroupId)?.templates ?? []
}
