import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const RUNTIME_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'
export const PHI_PROJECT_CONFIG_DIR_NAME = '.phi'
export const CURRENT_SDK_PROJECT_CONFIG_DIR_NAME = '.omp'
export const LEGACY_PROJECT_CONFIG_DIR_NAMES = ['.omp', '.pi'] as const

export type ProjectResourceName = 'extensions' | 'prompts' | 'skills' | 'themes'

export function getDefaultPhiAgentDir(): string {
  return join(homedir(), '.phi')
}

export function getPhiAgentDir(): string {
  return process.env[RUNTIME_AGENT_DIR_ENV] || getDefaultPhiAgentDir()
}

export function getPhiWorkspaceDir(): string {
  return join(getPhiAgentDir(), 'workspace')
}

export function getPhiProjectDir(cwd: string): string {
  return join(cwd, PHI_PROJECT_CONFIG_DIR_NAME)
}

export function getGlobalMcpConfigPaths(agentDir = getPhiAgentDir()): string[] {
  return [
    join(agentDir, 'mcp.json'),
    join(agentDir, 'mcpServers.json'),
    join(agentDir, 'settings.json')
  ]
}

export function getProjectMcpConfigPaths(cwd: string): string[] {
  return [
    join(cwd, PHI_PROJECT_CONFIG_DIR_NAME, 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, '.omp', 'mcp.json'),
    join(cwd, '.pi', 'mcp.json')
  ]
}

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
