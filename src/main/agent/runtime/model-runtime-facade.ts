import { getPhiEngine } from '../engine/in-process-engine'
import type {
  PhiEngine,
  RuntimeCredential,
  RuntimeModel,
  RuntimeProvider,
  RuntimeProviderAuthStatus,
  RuntimeSnapshot
} from '../engine/types'
import { isModelEnabled, readModelAvailability } from '../model-availability'
import { getPhiAgentDir } from '../runtime-paths'
import type { AuthEvent, AuthInteraction, AuthPrompt, ModelRuntime } from './runtime-adapter'

export class OmpModelRuntimeFacade implements ModelRuntime {
  private providers: RuntimeSnapshot['providers']
  private models: RuntimeModel[]
  private credentials: RuntimeCredential[]

  constructor(
    private readonly engine: PhiEngine,
    private readonly agentDir: string,
    snapshot: RuntimeSnapshot
  ) {
    this.providers = snapshot.providers
    this.models = snapshot.models
    this.credentials = snapshot.credentials
  }

  static async create(agentDir = getPhiAgentDir()): Promise<OmpModelRuntimeFacade> {
    const engine = getPhiEngine()
    const snapshot = await engine.models.snapshot({ agentDir })
    return new OmpModelRuntimeFacade(engine, agentDir, snapshot)
  }

  getProviders(): RuntimeProvider[] {
    return this.providers
  }

  getModels(): RuntimeModel[] {
    const availability = readModelAvailability(this.agentDir)
    return this.models.filter((model) => isModelEnabled(availability, model.provider, model.id))
  }

  getModel(providerId: string, modelId: string): RuntimeModel | undefined {
    if (!isModelEnabled(readModelAvailability(this.agentDir), providerId, modelId)) return undefined
    return this.models.find((model) => model.provider === providerId && model.id === modelId)
  }

  getProviderAuthStatus(providerId: string): RuntimeProviderAuthStatus {
    return (
      this.providers.find((provider) => provider.id === providerId)?.status ?? {
        configured: false
      }
    )
  }

  async listCredentials(): Promise<RuntimeCredential[]> {
    return this.credentials
  }

  async login(
    providerId: string,
    type: 'api_key' | 'oauth',
    interaction: AuthInteraction
  ): Promise<void> {
    const cleanups: Array<() => void> = []
    cleanups.push(
      this.engine.models.onAuthNotify(({ providerId: notifiedProviderId, event }) => {
        if (notifiedProviderId !== providerId) return
        interaction.notify(event as AuthEvent)
      })
    )
    cleanups.push(
      this.engine.models.onAuthPrompt(({ providerId: promptProviderId, requestId, prompt }) => {
        if (promptProviderId !== providerId) return
        void interaction
          .prompt(prompt as AuthPrompt)
          .then((value) => this.engine.models.respondAuthPrompt(requestId, value))
          .catch((error: unknown) => this.engine.models.rejectAuthPrompt(requestId, error))
      })
    )

    try {
      const key =
        type === 'api_key' ? await interaction.prompt({ type: 'secret', message: '' }) : undefined
      const snapshot = await this.engine.models.login({
        agentDir: this.agentDir,
        providerId,
        type,
        key
      })
      this.update(snapshot)
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  }

  async logout(providerId: string): Promise<void> {
    const snapshot = await this.engine.models.logout({
      agentDir: this.agentDir,
      providerId
    })
    this.update(snapshot)
  }

  private update(snapshot: RuntimeSnapshot): void {
    this.providers = snapshot.providers
    this.models = snapshot.models
    this.credentials = snapshot.credentials
  }
}
