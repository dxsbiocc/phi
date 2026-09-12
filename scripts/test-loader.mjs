import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Run source-level regression tests without adding a second build toolchain.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(`${specifier}${suffix}`, context.parentURL)
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
      }
      throw error
    }
  },
  load(url, context, nextLoad) {
    // Vite/electron-vite handles CSS imports in the real app build; under
    // the plain Node test runner there's no CSS loader, so stub them out.
    // (e.g. WrapperFlowDiagram.tsx imports '@xyflow/react/dist/style.css'.)
    if (url.startsWith('file:') && url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    if (url.startsWith('file:') && url.includes('.svg?raw')) {
      const source = JSON.stringify(readFileSync(fileURLToPath(new URL(url)), 'utf8'))
      return { format: 'module', source: `export default ${source}`, shortCircuit: true }
    }
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return nextLoad(url, context)
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX
      }
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
})
