import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePhiAgent, type PhiAgentDefinition } from './definition'

/** Only the bundled definition is eligible; project/global agent files stay out of SSH projects. */
export function loadRemoteWrapperAgent(bundledAgentsDir: string): PhiAgentDefinition | undefined {
  const filePath = join(bundledAgentsDir, 'Wrapper.md')
  let definition: PhiAgentDefinition
  try {
    definition = parsePhiAgent(filePath, readFileSync(filePath, 'utf8'), 'phi')
  } catch {
    return undefined
  }
  if (definition.name !== 'Wrapper') return undefined
  return {
    ...definition,
    description:
      'Remote-project Wrapper specialist: inspect and run bundled wrappers on the project SSH server, and work with its files and commands.',
    tools: [
      'read',
      'glob',
      'grep',
      'bash',
      'write',
      'edit',
      'wrapper_search',
      'wrapper_inspect',
      'wrapper_run',
      'wrapper_status',
      'wrapper_wait',
      'wrapper_cancel'
    ],
    skills: [],
    fallback: undefined,
    delegation:
      'Delegate wrapper discovery, inspection, remote submission, status or cancellation here. Runs default to this project SSH server; do not launch Nextflow or Slurm through Bash as a substitute.',
    systemPrompt: [
      "You are Wrapper, Phi's specialist for bundled Nextflow wrapper contracts in a remote SSH project. You receive one self-contained task from the main agent. Reply in the task language with a concise report and real remote paths.",
      "Use wrapper_search and wrapper_inspect to find and inspect Phi's bundled wrapper catalog. The ordinary read/glob/grep/bash/write/edit tools route to the selected SSH host and project root. Never treat Phi's local session anchor as project files.",
      'Read a remote file before editing it. write/edit reject stale content. Bash is for short checks; its cwd is the project root but it is not a file sandbox.',
      'Use wrapper_run for remote submission; omit target to use this project SSH server. Explicit target: local is rejected. Before submission, Phi checks the saved server and environment, and it will not fall back to the local machine. Use wrapper_status/wait/cancel for an existing run. Never launch Nextflow or Slurm through Bash as a substitute.',
      "Project Skills/MCP and editing Phi's bundled wrapper source remain unavailable. Remote run inputs refer to files on this project's server: relative paths resolve under its remote project root, absolute paths must remain inside that root, and local-source references are rejected. Never substitute Phi's local session anchor.",
      'Your final report is all the main agent receives: state what you did, the absolute remote paths, and any unresolved problem.'
    ].join('\n\n')
  }
}
