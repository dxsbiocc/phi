export interface PassphraseStrength {
  level: 'weak' | 'fair' | 'strong'
  score: number
}

export function passphraseStrength(value: string): PassphraseStrength {
  let score = 0
  if (value.length >= 12) score += 1
  if (value.length >= 20) score += 1
  if (/\s/.test(value) || /[^A-Za-z0-9]/.test(value)) score += 1
  if (/[a-z]/.test(value) && /[A-Z0-9]/.test(value)) score += 1
  if (score >= 3) return { level: 'strong', score: 100 }
  if (score >= 2) return { level: 'fair', score: 66 }
  return { level: 'weak', score: 33 }
}
