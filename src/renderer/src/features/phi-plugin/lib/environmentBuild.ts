type ManagedEnvironmentBuildApi = {
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ) => Promise<{ envId: string }>
}

export function requestPhiPluginEnvironmentBuild(
  api: ManagedEnvironmentBuildApi,
  pluginId: string,
  environment: { ref: string }
): Promise<{ envId: string }> {
  return api.buildManagedEnvironment(environment.ref, undefined, pluginId)
}
