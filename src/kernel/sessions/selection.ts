import { writeManifestAtomic } from './persistence'
import type { PersistentSession, SessionManifest } from './types'

export async function updatePersistentSessionSelection(
  session: PersistentSession | undefined,
  patch: { model?: SessionManifest['model']; thinkingLevel?: string }
): Promise<void> {
  if (!session) return
  session.manifest = {
    ...session.manifest,
    ...(patch.model ? { model: { ...patch.model } } : {}),
    ...(patch.thinkingLevel ? { thinkingLevel: patch.thinkingLevel } : {}),
    updatedAt: new Date().toISOString()
  }
  await writeManifestAtomic(session.manifestPath, session.manifest)
}
