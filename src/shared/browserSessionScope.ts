/** User-only browser workspace when no Phi conversation is selected. Agent origins never resolve here. */
export const HUMAN_BROWSER_SESSION_ID = 'phi-human-browser'
export const HUMAN_BROWSER_SESSION_GENERATION = 0

export function browserPresentationSessionId(phiSessionId: string | null | undefined): string {
  return phiSessionId ?? HUMAN_BROWSER_SESSION_ID
}
