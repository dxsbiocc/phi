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
  const ownerPluginId = environment.ref.startsWith('plugin:') ? pluginId : undefined
  return api.buildManagedEnvironment(environment.ref, undefined, ownerPluginId)
}
