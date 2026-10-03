/**
 * Variable names the execution contract owns. `runInEnvironment` refuses them in
 * `extraEnv`, and an environment-bound bash call always takes them from the
 * environment. Dependency-free so the agent worker can import it.
 */
export function isReservedExecutionName(name: string): boolean {
  return (
    name === 'PATH' ||
    name.startsWith('PYTHON') ||
    name.startsWith('R_') ||
    name.startsWith('CONDA_') ||
    name.startsWith('MAMBA_') ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('PHI_ENV_')
  )
}
