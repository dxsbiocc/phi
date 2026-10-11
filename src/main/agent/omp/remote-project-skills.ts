type UnknownRecord = Record<string, unknown>

export interface RemoteProjectWorkerSkill {
  name: string
  description: string
  filePath: string
  baseDir: string
  source: string
  hide?: boolean
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function remoteProjectSkillsValue(value: unknown): RemoteProjectWorkerSkill[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): RemoteProjectWorkerSkill[] => {
    if (!isRecord(candidate) || !isRecord(candidate.remoteProject)) return []
    const name = candidate.name
    const description = candidate.description
    const filePath = candidate.filePath
    const relativePath = candidate.remoteProject.relativePath
    const contentHash = candidate.remoteProject.contentHash
    if (
      typeof name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) ||
      typeof description !== 'string' ||
      description.length < 1 ||
      description.length > 1024 ||
      typeof filePath !== 'string' ||
      !filePath.startsWith('ssh://') ||
      typeof relativePath !== 'string' ||
      !/^\.(?:phi|omp|pi)\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/u.test(relativePath) ||
      typeof contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(contentHash)
    ) {
      return []
    }
    return [
      {
        name,
        description,
        filePath,
        baseDir: filePath.slice(0, -'/SKILL.md'.length),
        source: 'server-project',
        ...(candidate.disableModelInvocation === true ? { hide: true } : {})
      }
    ]
  })
}

export function mergeRemoteProjectSkills<T extends RemoteProjectWorkerSkill>(
  base: readonly T[],
  direct: readonly T[],
  remoteProject: readonly RemoteProjectWorkerSkill[]
): Array<T | RemoteProjectWorkerSkill> {
  const directPaths = new Set(direct.map((skill) => skill.filePath))
  const remoteNames = new Set(remoteProject.map((skill) => skill.name))
  return [
    ...base.filter((skill) => !directPaths.has(skill.filePath) && !remoteNames.has(skill.name)),
    ...direct.filter((skill) => !remoteNames.has(skill.name)),
    ...remoteProject
  ]
}
