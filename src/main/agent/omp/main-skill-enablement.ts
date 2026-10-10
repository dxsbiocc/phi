/** Remote projects must not expose the local SDK anchor directory as a project skill scope. */
export function mainSkillEnablementOptions(
  cwd: string,
  agentDir: string,
  remoteRoot?: string
): { agentDir: string; projectDir?: string } {
  return { agentDir, ...(remoteRoot ? {} : { projectDir: cwd }) }
}
