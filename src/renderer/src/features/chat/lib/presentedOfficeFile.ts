import type { OfficeIpcResult, OfficeResolvedOutput } from '../../../../../shared/officeProtocol'
import type { PresentedFile } from '../../../../../shared/presentedFileTypes'

type ResolveOutput = (input: {
  artifactId: string
  outputId: string
}) => Promise<OfficeIpcResult<OfficeResolvedOutput>>

export async function resolvePresentedFileOpenPath(
  file: PresentedFile,
  resolveOutput?: ResolveOutput
): Promise<string> {
  if (!file.office) return file.path
  if (!resolveOutput) throw new Error('Office 交付入口暂不可用')
  const result = await resolveOutput({
    artifactId: file.office.artifactId,
    outputId: file.office.outputId
  })
  if (!result.ok) throw new Error(result.error.message)
  return result.value.path
}
