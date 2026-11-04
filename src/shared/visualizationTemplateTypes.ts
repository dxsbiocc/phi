/** Author-owned template gallery for the installed visualization plugin. */

export interface VisualizationTemplate {
  id: string
  title: string
  aliases: string[]
  /** Absolute path of the template preview.png inside the installed skill. */
  previewPath: string
}

export interface VisualizationTemplateGroup {
  id: string
  title: string
  templates: VisualizationTemplate[]
}

export interface VisualizationTemplateCatalog {
  groups: VisualizationTemplateGroup[]
}
