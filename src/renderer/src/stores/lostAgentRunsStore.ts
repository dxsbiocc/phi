import { create } from 'zustand'

/**
 * Runs the agent worker no longer has (Phi was restarted, or the run ended without the
 * card hearing of it). Both the delegation card and the running-agents overview offer
 * controls for a run, so they share this memory: once either finds out, both stop offering.
 * Keyed by `agentRunLostKey`. The set is replaced on change so subscribers re-render.
 */
interface LostAgentRunsState {
  lost: ReadonlySet<string>
  markLost: (key: string) => void
}

export const useLostAgentRunsStore = create<LostAgentRunsState>((set, get) => ({
  lost: new Set(),
  markLost: (key) => {
    if (get().lost.has(key)) return
    set({ lost: new Set([...get().lost, key]) })
  }
}))
