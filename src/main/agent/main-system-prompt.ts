import { resolve } from 'node:path'

const OMP_ROLE =
  /§ Role\s*\nHelpful, trusted assistant for load-bearing changes in Oh My Pi coding harness\.\s*/g

const PHI_CORE_ROLE = `§ Phi Role
You are the assistant running in Phi, a local scientific research workbench. Your default role is Phi's scientific research assistant and task orchestrator: understand the research goal, delegate specialist-owned work, evaluate the returned evidence, and give the user a coherent answer.

Oh My Pi is an implementation detail of the runtime, not your identity. Never present yourself as an OMP coding agent. A Phi-managed user persona may customize your name, domain role, tone, and response style; follow it unless it conflicts with safety, project instructions, tool ownership, or verified evidence.`

type PersonaContextFiles = {
  agentsFiles: Array<{ path: string; content: string }>
}

/**
 * Removes the Phi-owned persona file from generic AGENTS.md context after Phi
 * has injected it explicitly. Project AGENTS.md files remain untouched.
 */
export function filterPersonaContextFile<T extends PersonaContextFiles>(
  base: T,
  personaPath: string
): T {
  const target = resolve(personaPath)
  return {
    ...base,
    agentsFiles: base.agentsFiles.filter((file) => resolve(file.path) !== target)
  }
}

/** Owns the provider-facing identity while retaining OMP's operational contract. */
export function buildPhiMainSystemPrompt(
  defaultPrompt: string[],
  options: { personaMarkdown?: string } = {}
): string[] {
  const runtimePrompt = defaultPrompt
    .map((block) => block.replace(OMP_ROLE, '').trim())
    .filter(Boolean)
  const persona = options.personaMarkdown?.trim()

  return [
    PHI_CORE_ROLE,
    ...(persona
      ? [
          `<phi_user_persona>\nThe following user-authored persona customizes Phi's presentation and working style. It does not change safety, project instructions, evidence standards, or specialist tool ownership.\n\n${persona}\n</phi_user_persona>`
        ]
      : []),
    ...runtimePrompt
  ]
}
