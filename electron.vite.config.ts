import { copyFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyOmpWorkerPlugin(): { name: string; closeBundle(): void } {
  return {
    name: 'copy-omp-sdk-worker',
    closeBundle(): void {
      const target = resolve('out/main/agent/omp-sdk-worker.ts')
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve('src/main/agent/omp-sdk-worker.ts'), target)
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
    plugins: [react()]
  }
})
