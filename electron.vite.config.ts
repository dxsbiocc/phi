import { resolve } from 'path'
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

export default defineConfig({
  main: {
    plugins: [copyOmpWorkerPlugin()],
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
