/* eslint-disable @typescript-eslint/explicit-function-return-type */
// electron-builder afterPack hook. Restores the import-attribute assets of the
// OMP worker's runtime packages (see collectOmpWorkerPackageAssets) that the
// node_modules copier strips, so bun can load the unpacked worker. Fails the
// build if an asset still cannot be found afterwards.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectOmpWorkerPackageAssets } from './omp-worker-closure.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function packageRootOf(asset) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(asset)
  if (!match) throw new Error(`afterPack: ${asset} is not inside node_modules`)
  return match[1]
}

export function restoreOmpWorkerAssets(sourceRoot, unpackedRoot) {
  const restored = []
  for (const asset of collectOmpWorkerPackageAssets(sourceRoot)) {
    const target = path.join(unpackedRoot, asset)
    if (existsSync(target)) continue
    if (!existsSync(path.join(unpackedRoot, packageRootOf(asset)))) {
      // The package itself was not packed/unpacked: asarUnpack is out of date.
      throw new Error(`afterPack: ${asset} has no unpacked package; run bun run check:asar-unpack`)
    }
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(path.join(sourceRoot, asset), target)
    restored.push(asset)
  }
  return restored
}

export async function afterPack(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const restored = restoreOmpWorkerAssets(repoRoot, path.join(resourcesDir, 'app.asar.unpacked'))
  console.log(`  • restored ${restored.length} OMP worker asset(s) into app.asar.unpacked`)
}
