/** Author-owned template gallery for the installed visualization plugin. */

const TEMPLATE_PREVIEW_FILE = /^preview(?:_([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?\.png$/

/**
 * `preview.png`, or a sibling `preview_<name>.png` for another drawing of the
 * same template. `variant` is null for the primary file.
 */
export function templatePreviewFile(fileName: string): { variant: string | null } | null {
  const match = TEMPLATE_PREVIEW_FILE.exec(fileName)
  if (!match) return null
  return { variant: match[1] ?? null }
}

export interface VisualizationTemplate {
  id: string
  title: string
  aliases: string[]
  /** Absolute path of a template preview PNG inside the installed skill. */
  previewPath: string
  /** Set when this image is a `preview_<name>.png` variant of the catalog preview. */
  variant?: string
}

export interface VisualizationTemplateGroup {
  id: string
  title: string
  templates: VisualizationTemplate[]
}

export interface VisualizationTemplateCatalog {
  groups: VisualizationTemplateGroup[]
}
