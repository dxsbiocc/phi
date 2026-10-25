import packageJson from '@oh-my-pi/pi-coding-agent/package.json' with { type: 'json' }

type PackageMetadata = {
  version?: unknown
}

export function readOmpVersion(): string {
  const metadata: PackageMetadata = packageJson
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error('Installed OMP package does not declare a version')
  }
  return metadata.version
}
