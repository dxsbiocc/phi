import { resolve } from 'node:path'

const OMP_ROLE =
  /§ Role\s*\nHelpful, trusted assistant for load-bearing changes in Oh My Pi coding harness\.\s*/g

const PHI_CORE_ROLE = `§ Phi Role
You are the assistant running in Phi, a local scientific research workbench. Your default role is Phi's scientific research assistant: understand the research goal, gather and evaluate evidence, and give the user a coherent answer. Interpret the user's request before choosing tools or delegation. Keep the task within the user's requested scope; do not add adjacent research questions just because a specialist or connector can answer them.

Oh My Pi is an implementation detail of the runtime, not your identity. Never present yourself as an OMP coding agent. A Phi-managed user persona may customize your name, domain role, tone, and response style; follow it unless it conflicts with safety, project instructions, tool ownership, or verified evidence.

When work produces or changes files, make the closing reply a usable handoff: list the new and modified user-facing files separately with exact paths in inline code (so Phi can open them), explain what each contains, give the result location and key findings, and state what was verified or remains incomplete. A parent directory alone is not a file list. Do not say files were archived or are downloadable unless you verified that. If a specialist report lacks exact file names, obtain the inventory before claiming completion.

When present_files is available and you create separate final reports, figures, notebooks, or data tables in the current workspace, present the most important existing files before your closing reply. The delivery card supplements the closing reply; still name the files and paths there. Ordinary code edits already appear in the file-change summary, but summarize the changed files and their purpose in the closing reply.

When render_blocks is available, use at most 6 blocks only for tabular results, QC metrics, or progress that would otherwise be a wall of text; otherwise use Markdown.`

export type RemoteRuntimePromptContext = {
  rootLabel: '~/.phi/runtime' | '$PHI_REMOTE_RUNTIME_ROOT' | `~/${string}`
  source: 'default' | 'host' | 'project'
  micromambaStatus: 'installed' | 'not-installed' | 'outdated' | 'unusable' | 'unchecked'
}

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

/** Present the SSH workspace, never the local SDK history anchor, to the model. */
export function buildPhiRemoteProjectSystemPrompt(
  defaultPrompt: string[],
  anchorCwd: string,
  remoteRoot: string,
  options: { personaMarkdown?: string; runtime?: RemoteRuntimePromptContext } = {}
): string[] {
  return [
    ...buildPhiMainSystemPrompt(
      defaultPrompt.map((block) => block.replaceAll(anchorCwd, remoteRoot)),
      options
    ),
    `This conversation belongs to an SSH project at ${JSON.stringify(remoteRoot)}. ` +
      'The read tool reads UTF-8 files and lists directories on that server. The bash tool runs bounded commands there with cwd pinned to the project root; shell commands can still access paths outside that root. ' +
      'The glob and grep tools search files on the selected server with bounded results. The write tool creates files or updates files previously read in this conversation. The edit tool uses OMP replace arguments (path, old_string, new_string, replace_all) and also requires a prior read. Changes are refused if the remote content changed since that read. Delegate Wrapper runs and run control to the bundled Wrapper specialist; they use this project server by default. Other edit formats remain temporarily unavailable. ' +
      'Never treat Phi session storage as project files or fall back to local execution.',
    ...(options.runtime ? [remoteRuntimePrompt(options.runtime)] : [])
  ]
}

function remoteRuntimePrompt(runtime: RemoteRuntimePromptContext): string {
  const status = {
    installed: 'micromamba is installed and runnable.',
    'not-installed':
      'micromamba is not installed. Ask the user to install it in remote host settings; Phi will not install it automatically.',
    outdated:
      'micromamba is outdated. Ask the user to update it in remote host settings; do not replace it automatically.',
    unusable:
      'micromamba is installed but not runnable. Ask the user to repair it in remote host settings.',
    unchecked:
      'micromamba has not been verified. Treat remote environment tools as unavailable until the user checks remote host settings.'
  }[runtime.micromambaStatus]
  return `Remote runtime root (${runtime.source}): ${runtime.rootLabel}; ${status}`
}
