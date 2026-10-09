import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only the explicit package-content integration suite reads this external checkout. */
export function packageContentRoot(): string {
  const root = process.env.PHI_PACKAGES_ROOT
    ? resolve(process.env.PHI_PACKAGES_ROOT)
    : fileURLToPath(new URL('../../../phi-packages/', import.meta.url))
  if (!existsSync(resolve(root, 'resources'))) {
    throw new Error(
      `Phi Packages checkout is missing at ${root}. Clone phi-packages beside Phi or set PHI_PACKAGES_ROOT before running test:packages.`
    )
  }
  return root
}

export function packageContentPath(...parts: string[]): string {
  return resolve(packageContentRoot(), 'resources', ...parts)
}
