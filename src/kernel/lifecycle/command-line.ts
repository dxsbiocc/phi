const DEFAULT_GRACE_MS = 10 * 60 * 1000

export type KernelCommandLine =
  | { mode: 'stdio' }
  | {
      mode: 'listen'
      socketPath: string
      tokenFilePath: string
      graceMs: number
    }

export function parseKernelCommandLine(args: readonly string[]): KernelCommandLine {
  if (args.length === 0) return { mode: 'stdio' }

  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag || !['--listen', '--token-file', '--grace-ms'].includes(flag)) {
      throw new Error(`Unknown kernel argument: ${flag ?? '<missing>'}`)
    }
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be specified only once`)
    values.set(flag, value)
  }

  const socketPath = values.get('--listen')
  const tokenFilePath = values.get('--token-file')
  if (!socketPath || !tokenFilePath) {
    throw new Error('--listen and --token-file must be specified together')
  }
  const graceValue = values.get('--grace-ms')
  const graceMs = graceValue === undefined ? DEFAULT_GRACE_MS : Number(graceValue)
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0) {
    throw new Error('--grace-ms must be a positive integer')
  }
  return { mode: 'listen', socketPath, tokenFilePath, graceMs }
}
