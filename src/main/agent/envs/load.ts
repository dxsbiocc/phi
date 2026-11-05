import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import Ajv from 'ajv'

import { type EnvMetadata } from './contract'
import type { EnvHandle } from './execution'
import { envMetadataSchema } from './schemas'
import { readWslRuntime, usesWslEnvironment, wslEnvironmentPrefix } from './wsl'

import { errorMessage } from '../../../shared/errorCodes'

const ajv = new Ajv({ allErrors: true, strict: false })
const validateEnvMetadata = ajv.compile(envMetadataSchema)

function validationErrors(): string {
  return (validateEnvMetadata.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`.trim())
    .join('; ')
}

function loadMetadata(prefix: string, envId: string): EnvMetadata {
  const file = join(prefix, '.phi', 'env.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new Error(`environment ${envId} metadata is missing: ${file}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const message = errorMessage(error)
    throw new Error(`environment ${envId} metadata is invalid JSON: ${message}`)
  }
  if (!validateEnvMetadata(parsed)) {
    const detail = validationErrors()
    throw new Error(
      detail
        ? `environment ${envId} metadata is invalid: ${detail}`
        : `environment ${envId} metadata is invalid`
    )
  }
  const metadata = parsed as unknown as EnvMetadata
  if (metadata.envId !== envId) {
    throw new Error(`environment ${envId} metadata is for ${metadata.envId}`)
  }
  if (metadata.status !== 'ready') {
    throw new Error(`environment ${envId} is not ready (status: ${metadata.status})`)
  }
  return metadata
}

function verifyExecutable(prefix: string, envId: string, executable: string): void {
  const path = realpathSync(executable)
  const child = relative(realpathSync(prefix), path)
  if (isAbsolute(child) || child.startsWith('..') || !statSync(path).isFile()) {
    throw new Error(`environment ${envId} application executable is invalid or outside its prefix`)
  }
  accessSync(path, constants.X_OK)
}

export function loadEnvironment(root: string, envId: string): EnvHandle {
  const prefix = join(root, 'envs', envId)
  const metadata = loadMetadata(prefix, envId)
  if (metadata.installation) verifyExecutable(prefix, envId, metadata.installation.executable)
  if (usesWslEnvironment(process.platform, metadata.platform)) {
    const wsl = readWslRuntime(root)
    if (!wsl) throw new Error(`environment ${envId} is not ready (status: WSL runtime is missing)`)
    const linuxPrefix = wslEnvironmentPrefix(wsl, envId)
    if (!existsSync(join(linuxPrefix, 'conda-meta'))) {
      throw new Error(`environment ${envId} is not ready (status: WSL prefix is missing)`)
    }
    return { envId, prefix: linuxPrefix, metadata, wsl }
  }
  return { envId, prefix, metadata }
}
