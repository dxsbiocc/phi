/**
 * Fuzzy name matching for "did you mean" answers: a typo, the same words in another order, or
 * a name that contains what was typed. Shared by the tools that reject an unknown name.
 */

const MAX_SUGGESTIONS = 3

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[right.length]
}

interface Scored {
  name: string
  sharedWords: number
  contains: boolean
  distance: number
}

function score(input: string, name: string): Scored {
  const lowerInput = input.toLowerCase()
  const lowerName = name.toLowerCase()
  const inputWords = new Set(words(input))
  return {
    name,
    sharedWords: words(name).filter((word) => inputWords.has(word)).length,
    contains: lowerName.includes(lowerInput) || lowerInput.includes(lowerName),
    distance: editDistance(lowerInput, lowerName)
  }
}

/** The names most like `input`: a typo, the same words in another order, or a name containing it. */
export function closestNames(
  input: string,
  candidates: readonly string[],
  max: number = MAX_SUGGESTIONS
): string[] {
  const threshold = Math.max(2, Math.floor(input.length * 0.4))
  return candidates
    .map((name) => score(input, name))
    .filter((item) => item.sharedWords > 0 || item.contains || item.distance <= threshold)
    .sort(
      (left, right) =>
        right.sharedWords - left.sharedWords ||
        Number(right.contains) - Number(left.contains) ||
        left.distance - right.distance ||
        left.name.localeCompare(right.name)
    )
    .slice(0, max)
    .map((item) => item.name)
}
