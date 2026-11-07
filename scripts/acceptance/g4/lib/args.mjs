const KNOWN = new Set(['--dry-run', '--smoke', '--remote-only', '--local-only'])

export function parseArguments(argv) {
  const args = argv.slice(2)
  const unknown = args.filter((argument) => !KNOWN.has(argument))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(', ')}`)
  const remoteOnly = args.includes('--remote-only')
  const localOnly = args.includes('--local-only')
  if (remoteOnly && localOnly) throw new Error('--remote-only and --local-only exclude each other')
  return {
    dryRun: args.includes('--dry-run'),
    smoke: args.includes('--smoke'),
    remoteOnly,
    localOnly
  }
}
