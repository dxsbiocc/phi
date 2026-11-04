import { defineCopy } from '../../../lib/i18n'

/** Interface chrome for the template gallery. Catalog titles and aliases stay author text. */
export const visualizationCopy = defineCopy(
  {
    overview: 'Overview',
    templates: 'Templates',
    searchTemplates: 'Search templates',
    groups: 'Groups',
    allGroups: 'All',
    noTemplates: 'This plugin has no template previews',
    noMatches: 'No matching templates',
    loadingTemplates: 'Loading templates…',
    openPreview: (title: string) => `Open preview of ${title}`,
    closePreview: 'Close preview',
    showTemplates: 'Show templates',
    previousTemplate: 'Previous template',
    nextTemplate: 'Next template',
    groupNames: {
      scatter: 'Scatter',
      heatmap: 'Heatmap',
      bar: 'Bar',
      boxplot: 'Box plot',
      line: 'Line',
      pie: 'Pie',
      radar: 'Radar',
      graph: 'Graph',
      sankey: 'Sankey',
      sunburst: 'Sunburst',
      tree: 'Tree',
      ideogram: 'Ideogram'
    }
  },
  {
    overview: '概览',
    templates: '模板',
    searchTemplates: '搜索模板',
    groups: '分组',
    allGroups: '全部',
    noTemplates: '这个插件里没有模板图',
    noMatches: '没有匹配的模板',
    loadingTemplates: '正在加载模板…',
    openPreview: (title: string) => `打开${title}的预览`,
    closePreview: '关闭预览',
    showTemplates: '显示模板',
    previousTemplate: '上一张',
    nextTemplate: '下一张',
    groupNames: {
      scatter: '散点图',
      heatmap: '热图',
      bar: '柱状图',
      boxplot: '箱线图',
      line: '折线图',
      pie: '饼图',
      radar: '雷达图',
      graph: '网络图',
      sankey: '桑基图',
      sunburst: '旭日图',
      tree: '树状图',
      ideogram: '染色体图'
    }
  }
)

/** Short family name. Unknown catalog groups keep the author title. */
export function visualizationGroupLabel(groupId: string, fallback: string): string {
  const label = visualizationCopy.groupNames[groupId as keyof typeof visualizationCopy.groupNames]
  return typeof label === 'string' ? label : fallback
}
