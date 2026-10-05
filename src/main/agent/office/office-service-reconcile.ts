import { type OfficeReconcileFlow, type OfficeReconcileResult } from './office-reconcile'
import {
  assertOwnedOfficeDocumentActive,
  assertOwnedOfficeDocumentDeliverable,
  assertOwnedOfficeDocumentWritable,
  requireOwnedOfficeDocument
} from './office-service-guards'
import type { OwnedOfficeDocument } from './office-service-state'
import { OfficeWriteError } from './office-write-contract'

export class OfficeServiceReconcileFacade {
  constructor(
    private readonly reconciler: OfficeReconcileFlow,
    private readonly owned: ReadonlyMap<string, OwnedOfficeDocument>,
    private readonly closingArtifacts: ReadonlySet<string>
  ) {}

  assertWritable(artifactId: string): void {
    assertOwnedOfficeDocumentWritable(
      requireOwnedOfficeDocument(this.owned, this.closingArtifacts, artifactId)
    )
  }

  assertDeliverable(artifactId: string): void {
    assertOwnedOfficeDocumentDeliverable(
      requireOwnedOfficeDocument(this.owned, this.closingArtifacts, artifactId)
    )
  }

  async reconcile(artifactId: string, sessionId: string): Promise<OfficeReconcileResult> {
    const owned = requireOwnedOfficeDocument(
      this.owned,
      this.closingArtifacts,
      artifactId,
      sessionId
    )
    try {
      return await owned.operations.run((signal) => {
        assertOwnedOfficeDocumentActive(this.owned, this.closingArtifacts, owned, sessionId)
        return this.reconciler.reconcileOwned(owned, signal)
      })
    } catch (error) {
      if (error instanceof OfficeWriteError) throw error
      throw new OfficeWriteError('reconcile_failed', '核对未能可靠完成，文档继续冻结')
    }
  }
}
