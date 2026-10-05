import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { officeKindAdapter } from './office-kind-adapters'
import { createImmutableOfficeOutput } from './office-save-as-copy'
import { OfficeSaveAsError, validateOfficeSaveAsTarget } from './office-save-as-target'
import {
  appendOfficeOutputRecord,
  loadOfficeOutputLog,
  persistOfficeOutputLog,
  type OfficeOutputRecord,
  type OfficeOutputLogState
} from './office-output-log'
import {
  assertOwnedOfficeDocumentActive,
  assertOwnedOfficeDocumentDeliverable,
  requireOwnedOfficeDocument
} from './office-service-guards'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import { resolveRecordedOfficeOutput } from './office-output-path'
import { flushOwnedOfficeDocumentForOutput } from './office-output-save'
import type { OfficeSavedFileVerification } from './office-save'

export interface OfficeSaveAsDescriptor {
  readonly fileName: string
  readonly kind: OfficeDocumentKind
}

interface OfficeSaveAsFlowState {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeSaveAsFlow {
  constructor(private readonly state: OfficeSaveAsFlowState) {}

  descriptor(artifactId: string, sessionId: string): OfficeSaveAsDescriptor {
    const owned = requireOwnedOfficeDocument(
      this.state.owned,
      this.state.closingArtifacts,
      artifactId,
      sessionId
    )
    return {
      fileName: documentFileName(basename(owned.document.draftPath), owned.document.kind),
      kind: owned.document.kind
    }
  }

  async saveAsDocument(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    targetPath: string
  ): Promise<OfficeOutputRecord & { readonly fileName: string }> {
    const owned = requireOwnedOfficeDocument(
      this.state.owned,
      this.state.closingArtifacts,
      artifactId,
      sessionId
    )
    return owned.operations.run((signal) =>
      this.run(owned, sessionId, projectRoot, targetPath, signal)
    )
  }

  async resolveOutputPath(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    outputId: string
  ): Promise<string> {
    const draftPath = await this.resolveDraftPath(artifactId, sessionId)
    const result = await resolveRecordedOfficeOutput(
      draftPath,
      projectRoot,
      outputId,
      this.state.dependencies.loadOutputLog ?? loadOfficeOutputLog
    )
    return result.path
  }

  private async resolveDraftPath(artifactId: string, sessionId: string): Promise<string> {
    const owned = this.state.owned.get(artifactId)
    if (owned && !this.state.closingArtifacts.has(artifactId)) {
      if (owned.document.sessionId !== sessionId) {
        throw new OfficeSaveAsError('session_mismatch', '关联的 Office 文档不属于当前会话')
      }
      return owned.document.draftPath
    }
    const resolveRegistered = this.state.dependencies.resolveRegisteredDraftByArtifactId
    if (!resolveRegistered) {
      throw new OfficeSaveAsError('target_missing', '关联的 Office 文档已不存在或已关闭')
    }
    const artifact = await resolveRegistered(sessionId, artifactId)
    if (!artifact || artifact.sessionId !== sessionId || artifact.artifactId !== artifactId) {
      throw new OfficeSaveAsError('target_missing', 'Office 草稿登记记录不存在')
    }
    try {
      await this.state.dependencies.validateRegisteredDraft(artifact)
    } catch {
      throw new OfficeSaveAsError('output_integrity_failed', 'Office 草稿登记记录无法验证')
    }
    return artifact.draftPath
  }

  private async run(
    owned: OwnedOfficeDocument,
    sessionId: string,
    projectRoot: string,
    targetPath: string,
    signal: AbortSignal
  ): Promise<OfficeOutputRecord & { readonly fileName: string }> {
    this.assertDeliverable(owned, sessionId)
    const target = await validateOfficeSaveAsTarget(projectRoot, targetPath, owned.document.kind)
    const outputLog = await this.loadOutputLog(owned)
    const revision = owned.contentRevision
    const verification = await flushOwnedOfficeDocumentForOutput({
      dependencies: this.state.dependencies,
      owned,
      signal,
      assertActive: () =>
        assertOwnedOfficeDocumentActive(
          this.state.owned,
          this.state.closingArtifacts,
          owned,
          sessionId
        )
    })
    return createImmutableOfficeOutput(
      {
        binaryPath: owned.binaryPath,
        kind: owned.document.kind,
        sourcePath: owned.document.draftPath,
        targetPath: target.targetPath,
        expectedSha256: verification.sha256,
        signal
      },
      async ({ sha256, size }) => {
        const record = this.outputRecord(target.outputPath, revision, sha256, size)
        const next = appendOfficeOutputRecord(outputLog, record)
        await (this.state.dependencies.persistOutputLog ?? persistOfficeOutputLog)(
          owned.document.draftPath,
          next
        )
        return { ...record, fileName: target.fileName }
      },
      {
        verifyFile: (path) => this.verifyOutput(path, owned, signal)
      }
    )
  }

  private assertDeliverable(owned: OwnedOfficeDocument, sessionId: string): void {
    assertOwnedOfficeDocumentActive(this.state.owned, this.state.closingArtifacts, owned, sessionId)
    if (owned.readOnly) {
      throw new OfficeSaveAsError('document_read_only', '只读文档不能另存输出')
    }
    try {
      assertOwnedOfficeDocumentDeliverable(owned)
    } catch {
      if (owned.freezeState === 'unknown') {
        throw new OfficeSaveAsError('document_frozen', '写入结果待核对，不能另存输出')
      }
      throw new OfficeSaveAsError('save_failed', '草稿有未保存修改，请先保存草稿')
    }
  }

  private async loadOutputLog(owned: OwnedOfficeDocument): Promise<OfficeOutputLogState> {
    try {
      return await (this.state.dependencies.loadOutputLog ?? loadOfficeOutputLog)(
        owned.document.draftPath
      )
    } catch {
      throw new OfficeSaveAsError('output_log_corrupt', 'Office 输出记录无法验证')
    }
  }

  private verifyOutput(
    path: string,
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<OfficeSavedFileVerification> {
    const verify = this.state.dependencies.verifyOutputFile
    if (!verify) throw new OfficeSaveAsError('copy_verification_failed', '输出校验不可用')
    return verify(path, { binaryPath: owned.binaryPath, signal })
  }

  private outputRecord(
    outputPath: string,
    revision: number,
    sha256: string,
    size: number
  ): OfficeOutputRecord {
    return {
      outputId: (this.state.dependencies.outputId ?? randomUUID)(),
      outputPath,
      revision,
      sha256,
      size,
      createdAt: (this.state.dependencies.now ?? (() => new Date()))().toISOString(),
      source: 'draft'
    }
  }
}

function documentFileName(name: string, kind: OfficeDocumentKind): string {
  const extension = officeKindAdapter(kind).extension
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`
}
