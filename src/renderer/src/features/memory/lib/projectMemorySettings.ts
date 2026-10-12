import {
  normalizeProjectMemorySettings,
  type ProjectMemorySettings
} from '../../../../../shared/projectMemoryTypes'

/** Turning memory off also turns lesson recording off; lessons need a memory to live in. */
export function nextProjectMemorySettings(
  current: ProjectMemorySettings,
  key: keyof ProjectMemorySettings,
  value: boolean
): ProjectMemorySettings {
  return normalizeProjectMemorySettings({ ...current, [key]: value })
}

export function projectMemorySettings(project: {
  memory?: ProjectMemorySettings
}): ProjectMemorySettings {
  return normalizeProjectMemorySettings(project.memory)
}
