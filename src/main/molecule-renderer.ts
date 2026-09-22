import { createRequire } from 'node:module'
import type { MainModule } from '@rdkit/rdkit'

type RdkitInitializer = (options?: { locateFile?: (file: string) => string }) => Promise<MainModule>

type MoleculeSvgRenderInput = {
  value: string
  width: number
  height: number
}

const rdkitRequire = createRequire(import.meta.url)
const MOLECULE_INPUT_LIMIT = 50_000
const MIN_MOLECULE_RENDER_SIZE = 64
const MAX_MOLECULE_RENDER_SIZE = 800

let rdkitModulePromise: Promise<MainModule> | null = null
let rdkitWasmPath: string | null = null

function resolveRdkitWasmPath(): string {
  rdkitWasmPath ??= rdkitRequire.resolve('@rdkit/rdkit/RDKit_minimal.wasm')
  return rdkitWasmPath
}

function rdkitInitializer(): RdkitInitializer {
  const module = rdkitRequire('@rdkit/rdkit') as RdkitInitializer | { default?: RdkitInitializer }
  const initializer = typeof module === 'function' ? module : module.default
  if (typeof initializer !== 'function') {
    throw new Error('RDKit 初始化入口不可用')
  }
  return initializer
}

function renderSize(value: unknown, fallback: number): number {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(size)) return fallback
  return Math.min(MAX_MOLECULE_RENDER_SIZE, Math.max(MIN_MOLECULE_RENDER_SIZE, Math.round(size)))
}

export function normalizeMoleculeSvgRenderInput(
  value: unknown,
  width: unknown,
  height: unknown
): MoleculeSvgRenderInput {
  if (typeof value !== 'string') {
    throw new Error('分子表达式必须是字符串')
  }

  const trimmedValue = value.trim()
  if (!trimmedValue) {
    throw new Error('分子表达式不能为空')
  }
  if (trimmedValue.length > MOLECULE_INPUT_LIMIT) {
    throw new Error('分子表达式过长，无法预览')
  }

  return {
    value: trimmedValue,
    width: renderSize(width, 320),
    height: renderSize(height, 220)
  }
}

export function loadRdkit(): Promise<MainModule> {
  rdkitModulePromise ??= rdkitInitializer()({
    locateFile: (file) => (file.endsWith('.wasm') ? resolveRdkitWasmPath() : file)
  })
  return rdkitModulePromise
}

export async function renderMoleculeSvg(
  value: unknown,
  width: unknown,
  height: unknown
): Promise<string> {
  const input = normalizeMoleculeSvgRenderInput(value, width, height)
  const rdkit = await loadRdkit()
  const molecule = rdkit.get_mol(input.value)
  if (!molecule) throw new Error('RDKit 无法解析该分子表达式')

  try {
    return molecule.get_svg(input.width, input.height)
  } finally {
    molecule.delete()
  }
}
