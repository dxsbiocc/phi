import type { PluginCatalogItem, PromptAgentSummary, SkillSummary } from '../types'

function quotedPath(path: string): string {
  return `\`${path}\``
}

export function appendInputReference(input: string, reference: string): string {
  const trimmedReference = reference.trim()
  if (!trimmedReference) return input
  if (!input.trim()) return trimmedReference
  return `${input}${input.endsWith('\n') ? '' : '\n'}${trimmedReference}`
}

export function formatInputFileReferences(paths: string[]): string {
  const references = paths.map((path) => path.trim()).filter(Boolean)
  if (references.length === 0) return ''
  if (references.length === 1) return `引用文件：${quotedPath(references[0])}`
  return ['引用文件：', ...references.map((path) => `- ${quotedPath(path)}`)].join('\n')
}

export function formatSkillPromptReference(skill: Pick<SkillSummary, 'name'>): string {
  return `$${skill.name}`
}

export function formatPromptAgentReference(
  agent: Pick<PromptAgentSummary, 'name' | 'trigger'>
): string {
  return agent.trigger || `/prompts:${agent.name}`
}

export function formatPluginPromptReference(
  plugin: Pick<PluginCatalogItem, 'name' | 'source'>
): string {
  return `引用插件：${plugin.name}（${plugin.source}）`
}
