import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { type HostRequirement } from './contract'
import { type PhiPlatform } from './platform'

const HOST_SEARCH_DIRECTORIES = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']

export interface HostProbeResult {
  found: Record<string, string>
  missing: string[]
}

function isExecutable(filePath: string): boolean {
  if (!isAbsolute(filePath)) return false
  try {
    if (!statSync(filePath).isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findHostCommand(requirement: HostRequirement): string | undefined {
  for (const candidate of requirement.candidates ?? []) {
    if (isExecutable(candidate)) return candidate
  }
  if (requirement.name.includes('/') || requirement.name.includes('\0')) return undefined
  for (const directory of HOST_SEARCH_DIRECTORIES) {
    const candidate = join(directory, requirement.name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

export function probeHostRequirements(
  requirements: readonly HostRequirement[] | undefined,
  platform: PhiPlatform
): HostProbeResult {
  const found: Record<string, string> = {}
  const missing: string[] = []
  for (const requirement of requirements ?? []) {
    if (requirement.platforms && !requirement.platforms.includes(platform)) continue
    const path = findHostCommand(requirement)
    if (path) found[requirement.name] = path
    else missing.push(requirement.name)
  }
  return { found, missing }
}
