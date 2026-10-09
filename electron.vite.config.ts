import { copyFileSync, cpSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyOmpWorkerClosure } from './scripts/build/omp-worker-closure.mjs'

/**
 * `omp-sdk-worker.ts` runs as a standalone script (omp-bridge.ts spawns
 * `bun <worker>.ts`), so rollup never bundles it: bun resolves its relative
 * imports at runtime against whatever sits next to the copy in `out/`. This
 * plugin copies the worker plus its full relative-import closure, derived from
 * the import graph by `scripts/build/omp-worker-closure.mjs`, mirroring the
 * `src/` layout under `out/`. `bun run check:asar-unpack` verifies that
 * electron-builder.yml unpacks the same set, since bun cannot read app.asar.
 */
function copyOmpWorkerPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-omp-sdk-worker',
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

export default defineConfig({
  main: {
    plugins: [copyOmpWorkerPlugin(), copyTerminalWorkersPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'environment-worker': resolve('src/main/agent/environment/scan-worker.ts')
        },
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name].mjs',
          // Both entry points use the runtime barrel. Keep its mutually dependent
          // modules together so exported bindings initialize in the same chunk.
          manualChunks(id): string | undefined {
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
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
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
