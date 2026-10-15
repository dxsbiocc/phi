import { createHash } from 'node:crypto'
import {
  CHILD_SKILL_DIRECTORY,
  CHILD_SKILL_MAX_BYTES,
  childProfileResourceDigest,
  childResourceHash,
  rpcChildEffectivePrompt,
  snapshotChildResourceJson,
  validateChildResourceCatalog,
  type RpcChildEnvironmentResource,
  type RpcChildResourceCatalog
} from '../../phi-extension/lib/rpc-child-resources'
import { rpcChildPromptDigest } from '../../phi-extension/lib/rpc-child-protocol'
import type { PhiExtensionFile } from '../extension-deployment/types'
import type { RpcAgentDefinitionProfile, RpcAgentResourceCatalogInput } from './types'

interface SkillContent {
  readonly name: string
  readonly markdown: string
}
export interface ProductionChildResourceSnapshot {
  readonly catalog: Readonly<RpcChildResourceCatalog>
  readonly contents: readonly SkillContent[]
}
export interface PreparedProductionChildResources {
  readonly catalog?: Readonly<RpcChildResourceCatalog>
  readonly contents: readonly SkillContent[]
  readonly files: readonly PhiExtensionFile[]
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function resourceRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new Error('Invalid desktop child resource record')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).sort().join(',') !== [...keys].sort().join(',') ||
    keys.some((key) => !fields[key] || !('value' in fields[key]))
  )
    throw new Error('Desktop child resource fields must be plain data')
  return Object.fromEntries(keys.map((key) => [key, fields[key].value]))
}

function resourceArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 1024 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error('Invalid desktop child resource roster')
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !('value' in field))
      throw new Error('Desktop child resource entries must be plain data')
    return field.value
  })
}

/** Detach all desktop schemas and Markdown before asynchronous environment lookup. */
export function snapshotProductionChildResources(
  input?: RpcAgentResourceCatalogInput
): ProductionChildResourceSnapshot | undefined {
  if (input === undefined) return undefined
  const raw = resourceRecord(input, ['hostTools', 'skills'])
  const hostTools = resourceArray(raw.hostTools).map((value: unknown) => {
    const tool = resourceRecord(value, ['name', 'description', 'parameters'])
    const parameters = snapshotChildResourceJson(tool.parameters)
    return { ...tool, parameters, schemaSha256: childResourceHash(parameters) }
  })
  const contents: SkillContent[] = []
  const skills = resourceArray(raw.skills).map((value: unknown) => {
    const skill = resourceRecord(value, ['name', 'description', 'markdown'])
    if (
      typeof skill.markdown !== 'string' ||
      !skill.markdown ||
      Buffer.byteLength(skill.markdown, 'utf8') > CHILD_SKILL_MAX_BYTES
    )
      throw new Error('Invalid or oversized trusted child skill Markdown')
    const hash = sha256(skill.markdown)
    contents.push(Object.freeze({ name: skill.name as string, markdown: skill.markdown }))
    return {
      name: skill.name,
      description: skill.description,
      path: `${CHILD_SKILL_DIRECTORY}/${hash}.md`,
      sha256: hash
    }
  })
  return Object.freeze({
    catalog: validateChildResourceCatalog({ hostTools, skills, environments: [] }),
    contents: Object.freeze(contents)
  })
}

/** Publish one selected catalogue and one copy of each selected Markdown artifact. */
export function prepareProductionChildResources(
  snapshot: ProductionChildResourceSnapshot | undefined,
  profiles: readonly RpcAgentDefinitionProfile[]
): PreparedProductionChildResources {
  const hostNames = new Set(
    profiles.flatMap((profile) =>
      profile.tools.filter((tool) => tool.site === 'host').map((tool) => tool.name)
    )
  )
  const skillNames = new Set(profiles.flatMap((profile) => [...profile.skills]))
  const environments = new Map<string, RpcChildEnvironmentResource>()
  for (const profile of profiles) {
    const environment = profile.environment
    if (!environment) continue
    if (!environment.execution) throw new Error('Child environment lacks ready managed execution')
    const resource: RpcChildEnvironmentResource = {
      ...environment,
      execution: environment.execution
    }
    const key = JSON.stringify([resource.ref, resource.pluginId ?? null])
    const previous = environments.get(key)
    if (previous && childResourceHash(previous) !== childResourceHash(resource))
      throw new Error('Selected child environment changed during compilation')
    environments.set(key, resource)
  }
  if (!hostNames.size && !skillNames.size && !environments.size)
    return Object.freeze({ contents: Object.freeze([]), files: Object.freeze([]) })
  const hostTools = [...hostNames].map((name) => {
    const resource = snapshot?.catalog.hostTools.find((tool) => tool.name === name)
    if (!resource) throw new Error(`Declared child host schema is unavailable: ${name}`)
    return resource
  })
  const skills = [...skillNames].map((name) => {
    const resource = snapshot?.catalog.skills.find((skill) => skill.name === name)
    if (!resource) throw new Error(`Declared child skill content is unavailable: ${name}`)
    return resource
  })
  const catalog = validateChildResourceCatalog({
    hostTools,
    skills,
    environments: [...environments.values()]
  })
  const contents = [...skillNames].map((name) => {
    const content = snapshot?.contents.find((skill) => skill.name === name)
    if (!content) throw new Error(`Declared child skill Markdown is unavailable: ${name}`)
    return content
  })
  const files = new Map<string, PhiExtensionFile>()
  for (const resource of catalog.skills) {
    const content = contents.find((skill) => skill.name === resource.name)!
    const bytes = Buffer.from(content.markdown, 'utf8')
    if (bytes.length > CHILD_SKILL_MAX_BYTES || sha256(content.markdown) !== resource.sha256)
      throw new Error('Trusted child skill changed before publication')
    files.set(resource.path, { path: resource.path, sha256: resource.sha256, bytes })
  }
  return Object.freeze({
    catalog,
    contents: Object.freeze(contents),
    files: Object.freeze([...files.values()])
  })
}

export function productionChildProfileResources(
  profile: RpcAgentDefinitionProfile,
  basePrompt: readonly string[],
  resources: PreparedProductionChildResources
): { readonly resourcesDigest?: string; readonly effectivePromptDigest?: string } {
  if (!resources.catalog) return {}
  const skills = profile.skills.map((name) => {
    const content = resources.contents.find((skill) => skill.name === name)
    if (!content) throw new Error('Selected child skill content changed')
    return content
  })
  const environment = profile.environment
    ? resources.catalog.environments.find(
        (item) =>
          item.ref === profile.environment!.ref && item.pluginId === profile.environment!.pluginId
      )
    : undefined
  return {
    resourcesDigest: childProfileResourceDigest(profile, resources.catalog),
    effectivePromptDigest: rpcChildPromptDigest(
      rpcChildEffectivePrompt(basePrompt, skills, environment)
    )
  }
}
