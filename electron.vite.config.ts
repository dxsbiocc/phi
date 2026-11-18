import { copyFileSync, cpSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { normalizePath, type Plugin } from 'vite'
import { copyOmpWorkerClosure } from './scripts/build/omp-worker-closure.mjs'

const mainBootstrap = normalizePath(resolve('src/main/bootstrap.ts'))

function bootstrapDependencies(
  getModuleInfo: (id: string) => { importedIds: readonly string[] } | null
): Set<string> {
  const pending = new Set([mainBootstrap])
  for (const id of pending) {
    for (const dependency of getModuleInfo(id)?.importedIds ?? []) pending.add(dependency)
  }
  return pending
}

/**
 * `engine/in-process/main.ts` runs as a standalone script (omp-bridge.ts spawns
 * `bun <worker>.ts`), so rollup never bundles it: bun resolves its relative
 * imports at runtime against whatever sits next to the copy in `out/`. This
 * plugin copies the worker plus its full relative-import closure, derived from
 * the import graph by `scripts/build/omp-worker-closure.mjs`, mirroring the
 * `src/` layout under `out/`. `bun run check:asar-unpack` verifies that
 * electron-builder.yml unpacks the same set, since bun cannot read app.asar.
 */
function copyOmpWorkerPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-omp-in-process-worker',
    closeBundle(): void {
      copyOmpWorkerClosure(resolve('.'))
    }
  }
}

/**
 * Terminal PTYs and cleanup supervision run as standalone Bun processes. Copy
 * their TypeScript sources and public constants verbatim so relative imports
 * keep the same layout in development, unpacked builds, and app.asar.unpacked.
 */
function copyTerminalWorkersPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-terminal-workers',
    closeBundle(): void {
      const terminalTarget = resolve('out/main/terminal')
      mkdirSync(dirname(terminalTarget), { recursive: true })
      cpSync(resolve('src/main/terminal'), terminalTarget, { recursive: true })

      const sharedTarget = resolve('out/shared/terminalTypes.ts')
      mkdirSync(dirname(sharedTarget), { recursive: true })
      copyFileSync(resolve('src/shared/terminalTypes.ts'), sharedTarget)
    }
  }
}

const keepMolstarDeferred: Plugin = {
  name: 'keep-molstar-deferred',
  generateBundle(_, bundle) {
    const startupFiles = new Set(
      Object.values(bundle).flatMap((file) =>
        file.type === 'chunk' && file.isEntry ? [file.fileName] : []
      )
    )
    for (const name of startupFiles) {
      const chunk = bundle[name]
      if (chunk?.type !== 'chunk') continue
      if (chunk.moduleIds.some((id) => id.includes('node_modules/molstar/'))) {
        this.error(`The renderer loads the Mol* viewer during startup via ${name}`)
      }
      for (const dependency of chunk.imports) startupFiles.add(dependency)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyOmpWorkerPlugin(), copyTerminalWorkersPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: mainBootstrap,
          'environment-worker': resolve('src/main/agent/environment/scan-worker.ts')
        },
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name].mjs',
          manualChunks(id, { getModuleInfo }): string | undefined {
            // Keep shared logging and preferences out of the workbench runtime's
            // static imports so that bootstrap can catch failures loading that runtime.
            if (id !== mainBootstrap && bootstrapDependencies(getModuleInfo).has(id)) {
              return 'startup-support'
            }
            // Keep the mutually dependent environment modules in the same chunk.
            if (id.includes('/src/main/agent/envs/')) return 'environment-runtime'
            return undefined
          }
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name].mjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), keepMolstarDeferred],
    build: {
      rollupOptions: {
        output: {
          // Keep shared dependencies such as React out of optional viewer chunks.
          // Otherwise the home screen imports the Mol* viewer just to load React.
          onlyExplicitManualChunks: true,
          manualChunks(id): string | undefined {
            if (id.includes('node_modules/molstar/')) {
              return 'molstar'
            }
            if (id.includes('node_modules/@rdkit/rdkit/')) {
              return 'rdkit'
            }
            if (id.includes('node_modules/cytoscape/')) {
              return 'cytoscape'
            }
            return undefined
          }
        }
      }
    }
  }
})
