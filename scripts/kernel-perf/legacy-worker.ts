import { measureSameRunLegacyFourSessionInProcess } from './legacy'

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive.`)
  return parsed
}

const projectFiles = positiveInteger(process.argv[2], 'project files')
const rounds = positiveInteger(process.argv[3], 'rounds')
const mcpExecutable = process.argv[4]
if (!mcpExecutable) throw new Error('MCP executable is required.')

const result = await measureSameRunLegacyFourSessionInProcess(projectFiles, rounds, mcpExecutable)
process.stdout.write(`${JSON.stringify(result)}\n`)
