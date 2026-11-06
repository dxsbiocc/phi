/**
 * Sends the first message of a conversation started from the home prompt.
 *
 * Opening the new conversation reloads the model state for it, and the shared
 * sender silently refuses while that reload is in flight. The home prompt has
 * already left the screen by then, so a refusal must not lose the text: wait
 * for the model state first, and if the message still is not sent, hand the
 * text to the new conversation's composer and say so.
 */
export type HomePromptSendDeps = {
  isModelStateReady: () => boolean
  send: () => Promise<boolean>
  keepUnsentText: () => void
  reportUnsent: () => void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export const HOME_PROMPT_READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 50

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function waitForModelState(deps: HomePromptSendDeps): Promise<void> {
  const wait = deps.wait ?? defaultWait
  const now = deps.now ?? Date.now
  const deadline = now() + HOME_PROMPT_READY_TIMEOUT_MS
  while (!deps.isModelStateReady() && now() < deadline) await wait(READY_POLL_MS)
  // The sender reads readiness from the last committed render; let it commit.
  await wait(0)
}

export async function sendHomePrompt(deps: HomePromptSendDeps): Promise<boolean> {
  let sent = false
  try {
    await waitForModelState(deps)
    sent = await deps.send()
  } catch {
    sent = false
  }
  if (!sent) {
    deps.keepUnsentText()
    deps.reportUnsent()
  }
  return sent
}
