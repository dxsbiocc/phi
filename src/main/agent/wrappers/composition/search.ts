/**
 * Keyword ranking for `wrapper_search`. A query is split into words and every word
 * must appear somewhere in a wrapper's id, name or summary; a word in the id or name
 * counts for more than one in the summary. When no wrapper has every word, the wrappers
 * that have some come back ranked, flagged so the caller can say so.
 */

export interface SearchableWrapper {
  manifest: { id: string; name: string; summary: string }
}

export interface WrapperSearchOutcome<T extends SearchableWrapper> {
  entries: T[]
  /** False when `entries` are partial matches: no wrapper contained every query word. */
  matchedAll: boolean
  /** Query words that no returned wrapper contains; empty when `matchedAll`. */
  unmatchedWords: string[]
}

const PRIMARY_WEIGHT = 3
const SUMMARY_WEIGHT = 1
/** How many consecutive words may be glued into one query word ("rna" + "seq" = "rnaseq"). */
const MAX_COMPOUND_WORDS = 3
/** A word this long or longer may be the stem of a longer query word ("align" of "alignment"). */
const MIN_STEM_LENGTH = 4
/** What a query word may add to a stem: inflections only, so "fastqc" is not "fastq" + "c". */
const INFLECTION = /^(s|es|ed|ing|ming|ping|ting|ment|ments|ation|ations|ion|ions|er|ers)$/

/** Words this long that share a start this long are the same word in another form (quantify / quantification). */
const MIN_SHARED_PREFIX = 7

function sharesLongPrefix(left: string, right: string): boolean {
  if (left.length < MIN_SHARED_PREFIX || right.length < MIN_SHARED_PREFIX) return false
  return left.slice(0, MIN_SHARED_PREFIX) === right.slice(0, MIN_SHARED_PREFIX)
}

function isInflectionOf(word: string, stem: string): boolean {
  return (
    stem.length >= MIN_STEM_LENGTH &&
    word.startsWith(stem) &&
    INFLECTION.test(word.slice(stem.length))
  )
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

interface Haystack {
  words: string[]
  /** Runs of consecutive whole words joined together, so "RNA-seq" is found by "rnaseq". */
  compounds: Set<string>
}

function haystack(text: string): Haystack {
  const list = words(text)
  const compounds = new Set<string>()
  for (let start = 0; start < list.length; start += 1) {
    let joined = list[start]
    for (let end = start + 1; end < Math.min(list.length, start + MAX_COMPOUND_WORDS); end += 1) {
      joined += list[end]
      compounds.add(joined)
    }
  }
  return { words: list, compounds }
}

function contains(target: Haystack, word: string): boolean {
  return (
    target.compounds.has(word) ||
    target.words.some(
      (candidate) =>
        candidate.includes(word) ||
        isInflectionOf(word, candidate) ||
        sharesLongPrefix(word, candidate)
    )
  )
}

function wordScore(primary: Haystack, summary: Haystack, word: string): number {
  if (contains(primary, word)) return PRIMARY_WEIGHT
  if (contains(summary, word)) return SUMMARY_WEIGHT
  return 0
}

export function rankWrapperEntries<T extends SearchableWrapper>(
  entries: readonly T[],
  query: string
): WrapperSearchOutcome<T> {
  const queryWords = [...new Set(words(query))]
  if (queryWords.length === 0)
    return { entries: [...entries], matchedAll: true, unmatchedWords: [] }

  const scored = entries.map((entry, order) => {
    const primary = haystack(`${entry.manifest.id} ${entry.manifest.name}`)
    const summary = haystack(entry.manifest.summary)
    const perWord = queryWords.map((word) => wordScore(primary, summary, word))
    return {
      entry,
      order,
      score: perWord.reduce((total, value) => total + value, 0),
      matched: perWord.filter((value) => value > 0).length,
      perWord
    }
  })

  const byRelevance = (left: (typeof scored)[number], right: (typeof scored)[number]): number =>
    right.score - left.score || left.order - right.order

  const full = scored.filter((item) => item.matched === queryWords.length).sort(byRelevance)
  if (full.length > 0) {
    return { entries: full.map((item) => item.entry), matchedAll: true, unmatchedWords: [] }
  }

  // One shared word among several is a coincidence ("seq" in "chip seq peak calling"), not a lead.
  const enough = Math.ceil(queryWords.length / 2)
  const partial = scored.filter((item) => item.matched >= enough).sort(byRelevance)
  const unmatchedWords = queryWords.filter((_, index) =>
    partial.every((item) => item.perWord[index] === 0)
  )
  return {
    entries: partial.map((item) => item.entry),
    matchedAll: partial.length === 0,
    unmatchedWords
  }
}
