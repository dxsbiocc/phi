/** A script tool as the main process describes it to the agent worker. */
export interface ScriptToolDescriptor {
  /** Registered name, `<toolPrefix>_<declaration name>`. */
  name: string
  description: string
  /** The declaration's `args` JSON Schema. */
  parameters: Record<string, unknown>
  attachTo: string[]
  /** Skill directory name. */
  skill: string
  /** Declared approval. A `project-path` argument can still require `write` at call time. */
  approval: 'read' | 'write'
}
