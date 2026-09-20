import { copyFileSync, cpSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyOmpWorkerPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-omp-sdk-worker',
    closeBundle(): void {
      const target = resolve('out/main/agent/omp/omp-sdk-worker.ts')
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve('src/main/agent/omp/omp-sdk-worker.ts'), target)
    }
  }
}

/**
 * `omp-sdk-worker.ts` runs as a standalone script (bun runs it directly —
 * see omp-bridge.ts's `spawn('bun', [workerPath])`), copied verbatim by
 * `copyOmpWorkerPlugin` above rather than bundled by rollup. That means its
 * relative imports are resolved by bun at runtime against whatever actually
 * sits next to the copied file in `out/` — unlike the Electron main process
 * bundle (rollup-flattened into one `out/main/index.mjs`), nothing here
 * gets pulled in automatically just because the source file imports it.
 *
 * Before `omp-sdk-worker.ts` imported `../wrappers/tools` (Milestone P1.8),
 * every one of its imports was either a Node builtin or an installed
 * package for exactly this reason — the file was kept dependency-free of
 * Phi's own other source files, and the two tiny helpers it needed from
 * `runtime-paths.ts` were duplicated inline instead of imported. That
 * approach doesn't scale to the whole `wrappers/` module (manifest
 * parsing, the catalog, plan creation, JSON Schema validation — real,
 * already-tested logic, not two helper functions), so this plugin instead
 * copies the worker's actual dependency closure into `out/`, mirroring the
 * same relative-path layout `src/` has: `../runtime-paths`, the wrapper
 * modules under `wrappers/` (in turn needing `../../../shared/`; note this
 * no longer drags along a `fixtures/` subtree — bundled wrapper packages
 * live under the project's `resources/wrappers/` now, which
 * `catalog.ts`'s own packaging-aware path resolution finds without any
 * copy-plugin help, unlike when they lived inside this directory), and —
 * added when `notebook-tools.ts`/
 * `runtime-session-text.ts` picked up direct imports from the worker,
 * mirroring the file layout after Milestone P1.11's `notebook/`/`runtime/`
 * reorganization — `../notebook/notebook-tools` and
 * `../runtime/runtime-session-text`. Verified against the actual dev build
 * (checked `out/main/agent/` after the build, not assumed) — if
 * `omp-sdk-worker.ts` grows a new `../`-relative dependency outside this
 * closure, it needs adding here too, the same way this plugin exists
 * because `runtime-paths.ts` alone wasn't enough once `wrappers/` was added.
 */
function copyOmpWorkerDepsPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-omp-worker-deps',
    closeBundle(): void {
      const wrappersTarget = resolve('out/main/agent/wrappers')
      mkdirSync(dirname(wrappersTarget), { recursive: true })
      cpSync(resolve('src/main/agent/wrappers'), wrappersTarget, { recursive: true })

      const runtimePathsTarget = resolve('out/main/agent/runtime-paths.ts')
      mkdirSync(dirname(runtimePathsTarget), { recursive: true })
      copyFileSync(resolve('src/main/agent/runtime-paths.ts'), runtimePathsTarget)

      const notebookToolsTarget = resolve('out/main/agent/notebook/notebook-tools.ts')
      mkdirSync(dirname(notebookToolsTarget), { recursive: true })
      copyFileSync(resolve('src/main/agent/notebook/notebook-tools.ts'), notebookToolsTarget)

      const runtimeSessionTextTarget = resolve('out/main/agent/runtime/runtime-session-text.ts')
      mkdirSync(dirname(runtimeSessionTextTarget), { recursive: true })
      copyFileSync(
        resolve('src/main/agent/runtime/runtime-session-text.ts'),
        runtimeSessionTextTarget
      )

      const sharedTarget = resolve('out/shared')
      mkdirSync(dirname(sharedTarget), { recursive: true })
      cpSync(resolve('src/shared'), sharedTarget, { recursive: true })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyOmpWorkerPlugin(), copyOmpWorkerDepsPlugin()],
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
