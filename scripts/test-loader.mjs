import { registerHooks, syncBuiltinESMExports } from 'node:module'
import fs, { readFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// --- Test data isolation -------------------------------------------------------------
// Tests must never write into the developer's real ~/.phi (logs, sessions, caches, MCP
// credentials). Point the app's data dir at a per-process temp dir unless a test or the
// caller already chose one, and fail loudly if anything still writes under the real dir.
const REAL_PHI_DIR = resolve(join(homedir(), '.phi'))
let isolatedAgentDir
if (!process.env.PI_CODING_AGENT_DIR) {
  isolatedAgentDir = fs.mkdtempSync(join(tmpdir(), 'phi-test-agent-'))
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir
}
process.on('exit', () => {
  if (isolatedAgentDir) fs.rmSync(isolatedAgentDir, { recursive: true, force: true })
})

// app-logger swallows write errors by design, so a thrown guard would be invisible. Block the
// write AND record the violation, then fail the process on exit.
const violations = new Set()
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain JS loader
function isUnderRealPhi(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) return false
  const abs = resolve(target instanceof URL ? fileURLToPath(target) : target)
  return abs === REAL_PHI_DIR || abs.startsWith(REAL_PHI_DIR + sep)
}
for (const name of ['appendFileSync', 'writeFileSync', 'mkdirSync']) {
  const original = fs[name]
  fs[name] = function guardedWrite(target, ...rest) {
    if (isUnderRealPhi(target)) {
      violations.add(`${name} ${String(target)}`)
      throw new Error(`Test attempted to write to the real Phi data dir: ${String(target)}`)
    }
    return original.call(this, target, ...rest)
  }
}
syncBuiltinESMExports()
process.on('exit', (code) => {
  if (violations.size === 0) return
  console.error(
    `\n[test-loader] Tests wrote to the real ~/.phi (isolate with PI_CODING_AGENT_DIR):\n  ${[...violations].join('\n  ')}`
  )
  if (code === 0) process.exitCode = 1
})

// Run source-level regression tests without adding a second build toolchain.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // A bare directory import ('../environment') throws ERR_UNSUPPORTED_DIR_IMPORT rather
      // than ERR_MODULE_NOT_FOUND; both should fall through to the index.ts lookup below.
      const retryable =
        error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
      if (!retryable || !specifier.startsWith('.')) throw error
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
