import { readDirectSkills } from '../../runtime/direct-skills'
import { mergeRemoteProjectSkills, remoteProjectSkillsValue } from '../remote-project-skills'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  ProjectResourceName,
  booleanValue,
  isRecord,
  stringArrayValue,
  stringValue
} from './common'
import {
  DefaultResourceLoader,
  SettingsManager,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
} from './session-factory'

export const PHI_PROJECT_CONFIG_DIR_NAME = '.phi'

export const CURRENT_SDK_PROJECT_CONFIG_DIR_NAME = '.omp'

export const LEGACY_PROJECT_CONFIG_DIR_NAMES = ['.omp', '.pi'] as const

export function getAdditionalProjectResourcePaths(
  cwd: string,
  resourceName: ProjectResourceName,
  runtimeProjectConfigDir = CURRENT_SDK_PROJECT_CONFIG_DIR_NAME
): string[] {
  const configDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES].filter(
    (dir, index, dirs) => dir !== runtimeProjectConfigDir && dirs.indexOf(dir) === index
  )

  return configDirs.map((dir) => join(cwd, dir, resourceName))
}

export function getKnownProjectResourceBaseDir(
  cwd: string,
  resourceName: ProjectResourceName,
  filePath: string
): string | undefined {
  const configDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES]
  const normalizedFile = resolve(filePath)

  for (const dir of configDirs) {
    const baseDir = resolve(cwd, dir, resourceName)
    const relativePath = relative(baseDir, normalizedFile)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      return baseDir
    }
  }

  return undefined
}

export function addExistingProjectResourcePaths(
  cwd: string,
  paths: string[] | undefined,
  resourceName: ProjectResourceName
): string[] | undefined {
  const projectPaths = getAdditionalProjectResourcePaths(cwd, resourceName).filter((path) =>
    existsSync(path)
  )
  const merged = [...new Set([...projectPaths, ...(paths ?? [])])]
  return merged.length > 0 ? merged : paths
}

export function resourceOptions(params: unknown): DefaultResourceLoaderOptions {
  const record = isRecord(params) ? params : {}
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const skillFiles = stringArrayValue(record.additionalSkillFiles) ?? []
  const remoteProjectSkills = remoteProjectSkillsValue(record.remoteProjectSkills)

  return {
    ...((skillFiles.length > 0 || remoteProjectSkills.length > 0) && !booleanValue(record.noSkills)
      ? {
          skillsOverride: (base) => {
            const direct = readDirectSkills(skillFiles)
            return {
              ...base,
              skills: mergeRemoteProjectSkills(base.skills, direct, remoteProjectSkills)
            }
          }
        }
      : {}),
    cwd,
    agentDir,
    additionalExtensionPaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalExtensionPaths),
      'extensions'
    ),
    additionalPromptTemplatePaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalPromptTemplatePaths),
      'prompts'
    ),
    additionalSkillPaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalSkillPaths),
      'skills'
    ),
    additionalThemePaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalThemePaths),
      'themes'
    ),
    noExtensions: booleanValue(record.noExtensions),
    noSkills: booleanValue(record.noSkills),
    noPromptTemplates: booleanValue(record.noPromptTemplates),
    noThemes: booleanValue(record.noThemes),
    noContextFiles: booleanValue(record.noContextFiles),
    systemPrompt: typeof record.systemPrompt === 'string' ? record.systemPrompt : undefined,
    appendSystemPrompt:
      typeof record.appendSystemPrompt === 'string' || Array.isArray(record.appendSystemPrompt)
        ? (record.appendSystemPrompt as string | string[])
        : undefined
  }
}

export function serializeSkill(cwd: string, skill: unknown): unknown {
  if (!isRecord(skill)) return skill
  const filePath = stringValue(skill.filePath)
  const sourceMeta = isRecord(skill._source) ? skill._source : undefined
  const existingSourceInfo = isRecord(skill.sourceInfo) ? skill.sourceInfo : undefined
  const projectBaseDir = filePath
    ? getKnownProjectResourceBaseDir(cwd, 'skills', filePath)
    : undefined
  const sourceInfo = {
    source:
      stringValue(existingSourceInfo?.source) ||
      stringValue(skill.source) ||
      stringValue(sourceMeta?.provider, 'local'),
    scope: projectBaseDir
      ? 'project'
      : stringValue(existingSourceInfo?.scope) ||
        (sourceMeta?.level === 'project' ? 'project' : 'user'),
    origin: projectBaseDir
      ? 'top-level'
      : stringValue(existingSourceInfo?.origin) || stringValue(sourceMeta?.origin),
    path: filePath || stringValue(existingSourceInfo?.path),
    baseDir:
      projectBaseDir || stringValue(existingSourceInfo?.baseDir) || stringValue(skill.baseDir)
  }

  return {
    ...skill,
    disableModelInvocation: skill.disableModelInvocation === true || skill.hide === true,
    sourceInfo
  }
}

export function markProjectSkills(
  cwd: string,
  result: { skills: unknown[]; diagnostics: ResourceDiagnostic[] }
): { skills: unknown[]; diagnostics: ResourceDiagnostic[] } {
  return {
    ...result,
    skills: result.skills.map((skill) => serializeSkill(cwd, skill))
  }
}

export async function reloadResources(params: unknown): Promise<unknown> {
  const options = resourceOptions(params)
  const loader = new DefaultResourceLoader({
    ...options,
    settingsManager: SettingsManager.create(options.cwd, options.agentDir)
  })
  await loader.reload()

  return {
    extensions: loader.getExtensions(),
    skills: markProjectSkills(options.cwd ?? process.cwd(), loader.getSkills()),
    prompts: loader.getPrompts(),
    themes: loader.getThemes(),
    agentsFiles: loader.getAgentsFiles(),
    systemPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: loader.getAppendSystemPrompt()
  }
}
