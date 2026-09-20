import { firstString, stripAccessionVersion } from './entrez-utils'

export function addFastaSequences(
  rows: Record<string, unknown>[],
  fasta: string
): Record<string, unknown>[] {
  const sequences = parseFastaSequences(fasta)
  return rows.map((row) => {
    const sequence = lookupFastaSequence(row, sequences)
    return sequence ? { ...row, sequence } : row
  })
}

function lookupFastaSequence(
  row: Record<string, unknown>,
  sequences: Map<string, string>
): string | undefined {
  const candidates = [firstString(row.accession), firstString(row.uid)].filter(
    (value): value is string => value !== undefined
  )
  for (const candidate of candidates) {
    const exact = sequences.get(candidate)
    if (exact) return exact
    const versionless = stripAccessionVersion(candidate)
    if (versionless !== candidate) {
      const match = sequences.get(versionless)
      if (match) return match
    }
  }
  return undefined
}

function parseFastaSequences(fasta: string): Map<string, string> {
  const sequences = new Map<string, string>()
  let header: string | undefined
  let parts: string[] = []
  const flush = (): void => {
    if (!header) return
    const sequence = parts.join('').replace(/\s+/g, '')
    if (!sequence) return
    for (const key of fastaHeaderKeys(header)) {
      if (!sequences.has(key)) sequences.set(key, sequence)
    }
  }

  for (const rawLine of fasta.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('>')) {
      flush()
      header = line.slice(1).trim()
      parts = []
    } else if (header) {
      parts.push(line)
    }
  }
  flush()
  return sequences
}

function fastaHeaderKeys(header: string): string[] {
  const keys = new Set<string>()
  const firstToken = header.split(/\s+/)[0]
  addFastaKey(keys, firstToken)
  for (const token of firstToken.split('|')) addFastaKey(keys, token)
  for (const match of header.matchAll(/[A-Z]{1,3}_\d+(?:\.\d+)?/g)) {
    addFastaKey(keys, match[0])
  }
  return Array.from(keys)
}

function addFastaKey(keys: Set<string>, value: string): void {
  const key = value.trim()
  if (!key) return
  keys.add(key)
  keys.add(stripAccessionVersion(key))
}
