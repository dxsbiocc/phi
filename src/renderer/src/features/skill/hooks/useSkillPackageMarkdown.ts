import { useEffect, useState } from 'react'

import type { SkillMarkdownState } from '../components/SkillDetailBody'
import { skillMarkdownBody } from '../lib/skillMarkdown'

interface Loaded {
  key: string
  content: string | null
  error: string | null
}

/** The SKILL.md of a catalog package: from disk when installed, else its verified archive. */
export function useSkillPackageMarkdown(
  registryDir: string | undefined,
  id: string
): SkillMarkdownState {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${registryDir ?? ''}\n${id}`

  useEffect(() => {
    if (!registryDir) return undefined
    let active = true
    window.api
      .readSkillPackageDetail(registryDir, id)
      .then((detail) => {
        if (!active) return
        setLoaded({
          key,
          content: detail.skillMd === null ? null : skillMarkdownBody(detail.skillMd),
          error: detail.skillMd === null ? '这个软件包里没有 SKILL.md。' : null
        })
      })
      .catch((cause) => {
        if (active) {
          setLoaded({
            key,
            content: null,
            error: cause instanceof Error ? cause.message : String(cause)
          })
        }
      })
    return () => {
      active = false
    }
  }, [registryDir, id, key])

  if (!registryDir) {
    return { content: null, isLoading: false, error: '这个技能没有可查看详情的来源。' }
  }
  if (!loaded || loaded.key !== key) return { content: null, isLoading: true, error: null }
  return { content: loaded.content, isLoading: false, error: loaded.error }
}
