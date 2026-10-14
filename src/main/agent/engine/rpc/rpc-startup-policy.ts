export const PHI_DISABLED_CAPABILITY_PROVIDERS = Object.freeze([
  'native',
  'claude',
  'codex',
  'omp-plugins',
  'claude-plugins'
] as const)

export function assertPhiModelProviderCompatible(provider: string): void {
  if ((PHI_DISABLED_CAPABILITY_PROVIDERS as readonly string[]).includes(provider))
    throw new Error(
      `Selected model provider "${provider}" conflicts with Phi's disabled capability providers; rename the model provider instead of allowing OMP to fall back.`
    )
}
