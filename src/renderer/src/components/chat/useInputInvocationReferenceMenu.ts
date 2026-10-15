import { useCallback, useMemo, useState } from 'react'
import {
  findActiveInputInvocationReference,
  formatPromptAgentReference,
  formatSkillPromptReference,
  removeInputInvocationReferenceRange,
  uniqueEnabledInputSkills,
  type InputReferenceCursor,
  type InputReferenceKeyboardEvent
} from '../../lib/inputReferences'
import type { PromptAgentSummary, SkillSummary } from '../../types'
import type {
  InputInvocationReferenceCandidate,
  InputInvocationReferenceMenuState
} from './InputInvocationReferenceMenu'

type UseInputInvocationReferenceMenuOptions = {
  input: string
  skills: readonly SkillSummary[]
  promptAgents: readonly PromptAgentSummary[]
  onInsertReference: (body: string, referenceText: string, cursor: number) => void
}

type UseInputInvocationReferenceMenuResult = {
  menuState: InputInvocationReferenceMenuState | null
  highlightedIndex: number
  onHighlight: (index: number) => void
  onInputChanged: (inputElement: InputReferenceCursor | null) => void
  onInputCursorChanged: (inputElement: InputReferenceCursor | null) => void
  onKeyDown: (event: InputReferenceKeyboardEvent) => boolean
  onSelect: (candidate: InputInvocationReferenceCandidate) => void
}

function candidateMatches(name: string, query: string): boolean {
  const normalizedName = name.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  return !normalizedQuery || normalizedName.includes(normalizedQuery)
}

function sortCandidates(
  candidates: InputInvocationReferenceCandidate[],
  query: string
): InputInvocationReferenceCandidate[] {
  const normalizedQuery = query.trim().toLowerCase()
  return [...candidates].sort((left, right) => {
    const leftName = left.name.toLowerCase()
    const rightName = right.name.toLowerCase()
    const leftStarts = normalizedQuery && leftName.startsWith(normalizedQuery)
    const rightStarts = normalizedQuery && rightName.startsWith(normalizedQuery)
    if (leftStarts !== rightStarts) return leftStarts ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export function useInputInvocationReferenceMenu({
  input,
  skills,
  promptAgents,
  onInsertReference
}: UseInputInvocationReferenceMenuOptions): UseInputInvocationReferenceMenuResult {
  const [inputCursor, setInputCursor] = useState(() => input.length)
  const [dismissedReferenceKey, setDismissedReferenceKey] = useState<string | null>(null)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const effectiveInputCursor = Math.min(inputCursor, input.length)
  const activeQuery = useMemo(
    () => findActiveInputInvocationReference(input, effectiveInputCursor),
    [effectiveInputCursor, input]
  )
  const activeKey = activeQuery
    ? `${activeQuery.kind}:${activeQuery.start}:${activeQuery.end}:${activeQuery.query}`
    : null
  const visibleQuery = activeKey && activeKey !== dismissedReferenceKey ? activeQuery : null
  const menuState = useMemo<InputInvocationReferenceMenuState | null>(() => {
    if (!visibleQuery) return null

    const candidates =
      visibleQuery.kind === 'skill'
        ? uniqueEnabledInputSkills(skills)
            .filter((skill) => candidateMatches(skill.name, visibleQuery.query))
            .map((skill): InputInvocationReferenceCandidate => {
              return {
                id: skill.id,
                ...(skill.icon ? { icon: skill.icon } : {}),
                kind: 'skill',
                name: skill.name,
                description: skill.description,
                referenceText: formatSkillPromptReference(skill)
              }
            })
        : promptAgents
            .filter((agent) => candidateMatches(agent.name, visibleQuery.query))
            .map((agent): InputInvocationReferenceCandidate => {
              return {
                id: agent.id,
                ...(agent.icon ? { icon: agent.icon } : {}),
                kind: 'agent',
                name: agent.name,
                description: agent.description,
                referenceText: formatPromptAgentReference(agent),
                agent,
                ...(agent.scope ? { scope: agent.scope } : {}),
                ...(agent.trustState ? { trustState: agent.trustState } : {}),
                ...(agent.available !== undefined ? { available: agent.available } : {}),
                ...(agent.diagnostics ? { diagnostics: agent.diagnostics } : {})
              }
            })

    return {
      kind: visibleQuery.kind,
      query: visibleQuery.query,
      operator: visibleQuery.operator,
      candidates: sortCandidates(candidates, visibleQuery.query)
    }
  }, [promptAgents, skills, visibleQuery])
  const effectiveHighlightedIndex = Math.min(
    highlightedIndex,
    Math.max(0, (menuState?.candidates.length ?? 0) - 1)
  )

  const updateInputCursor = useCallback(
    (inputElement: InputReferenceCursor | null): void => {
      setInputCursor(inputElement?.selectionStart ?? input.length)
    },
    [input.length]
  )

  const handleInputChanged = useCallback(
    (inputElement: InputReferenceCursor | null): void => {
      setDismissedReferenceKey(null)
      setHighlightedIndex(0)
      updateInputCursor(inputElement)
    },
    [updateInputCursor]
  )

  const selectCandidate = useCallback(
    (candidate: InputInvocationReferenceCandidate): void => {
      if (!activeQuery || candidate.available === false) return

      const replacement = removeInputInvocationReferenceRange(input, activeQuery)
      setDismissedReferenceKey(null)
      setHighlightedIndex(0)
      setInputCursor(replacement.cursor)
      onInsertReference(replacement.value, candidate.referenceText, replacement.cursor)
    },
    [activeQuery, input, onInsertReference]
  )

  const handleKeyDown = useCallback(
    (event: InputReferenceKeyboardEvent): boolean => {
      if (event.nativeEvent.isComposing) return false
      if (!visibleQuery || !menuState) return false

      const candidates = menuState.candidates

      if (event.key === 'Escape') {
        event.preventDefault()
        if (activeKey) {
          setDismissedReferenceKey(activeKey)
        }
        return true
      }

      if (candidates.length === 0) return false

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedIndex(
          (index) => (Math.min(index, candidates.length - 1) + 1) % candidates.length
        )
        return true
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedIndex(
          (index) =>
            (Math.min(index, candidates.length - 1) - 1 + candidates.length) % candidates.length
        )
        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const selectedCandidate = candidates[Math.min(highlightedIndex, candidates.length - 1)]
        if (selectedCandidate) {
          selectCandidate(selectedCandidate)
        }
        return true
      }

      return false
    },
    [activeKey, highlightedIndex, menuState, selectCandidate, visibleQuery]
  )

  return {
    menuState,
    highlightedIndex: effectiveHighlightedIndex,
    onHighlight: setHighlightedIndex,
    onInputChanged: handleInputChanged,
    onInputCursorChanged: updateInputCursor,
    onKeyDown: handleKeyDown,
    onSelect: selectCandidate
  }
}
