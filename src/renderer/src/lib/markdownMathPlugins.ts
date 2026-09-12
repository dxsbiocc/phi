import { useMemo } from 'react'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

// singleDollarTextMath:false requires $$...$$ for math (both inline and
// block use work with double dollars) instead of the ambiguous single $,
// which collides with plain "$5" currency text.
const remarkMathPlugin: [typeof remarkMath, Record<string, unknown>] = [
  remarkMath,
  { singleDollarTextMath: false }
]

// throwOnError:false degrades a malformed/false-positive math match to
// inline error text instead of throwing and taking down the whole render
// tree.
const rehypeKatexPlugin: [typeof rehypeKatex, Record<string, unknown>] = [
  rehypeKatex,
  { throwOnError: false, strict: 'ignore' }
]

/**
 * Off by default -- chat and other free-form prose regularly contains plain
 * "$5"-style dollar amounts, and turning math parsing on everywhere risks
 * misreading those as broken LaTeX. Callers opt in only for content where
 * that ambiguity doesn't apply (notebook markdown cells, kernel
 * `text/latex` output).
 */
export function useMarkdownPlugins(enableMath: boolean): {
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
} {
  const remarkPlugins = useMemo(
    () => (enableMath ? [remarkGfm, remarkMathPlugin] : [remarkGfm]),
    [enableMath]
  )
  const rehypePlugins = useMemo(() => (enableMath ? [rehypeKatexPlugin] : []), [enableMath])
  return { remarkPlugins, rehypePlugins }
}
