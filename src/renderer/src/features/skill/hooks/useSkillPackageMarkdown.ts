import { useUiLanguage } from '../../../lib/i18n'
import { skillCopy } from '../lib/skillCopy'
import { useEffect, useState } from 'react'

import type { SkillMarkdownState } from '../components/SkillDetailBody'
import { skillMarkdownBody } from '../lib/skillMarkdown'

interface Loaded {
  key: string
  content: string | null
  error: string | null
  missingMarkdown: boolean
}

/** The SKILL.md of a catalog package: from disk when installed, else its verified archive. */
export function useSkillPackageMarkdown(
  registryDir: string | undefined,
  id: string
): SkillMarkdownState {
  useUiLanguage()
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
          error: null,
          missingMarkdown: detail.skillMd === null
        })
      })
      .catch((cause) => {
        if (active) {
          setLoaded({
            key,
            content: null,
            error: cause instanceof Error ? cause.message : String(cause),
            missingMarkdown: false
          })
        }
      })
    return () => {
      active = false
    }
  }, [registryDir, id, key])

  if (!registryDir) {
    return { content: null, isLoading: false, error: skillCopy.missingDetailSource }
  }
  if (!loaded || loaded.key !== key) return { content: null, isLoading: true, error: null }
  return {
    content: loaded.content,
    isLoading: false,
    error: loaded.missingMarkdown ? skillCopy.missingMarkdown : loaded.error
  }
}
