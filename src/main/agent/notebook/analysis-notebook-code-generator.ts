import { basename } from 'node:path'
import type { PhiAgentEventSummary } from '../engine/types'
import { getAuthManager } from '../auth-manager'
import type { ModelSelection, ThinkingLevel } from '../projects'
import {
  createInMemoryRuntimeSessionManager,
  type ModelRuntime,
  type RuntimeModel
} from '../runtime/runtime-adapter'
import { createAgentSession } from '../session/session-manager'
import type {
  AnalysisNotebookExecutor,
  NotebookVariableIntrospection
} from './analysis-jupyter-execution'
import type { AnalysisNotebookSessionRegistry } from './analysis-jupyter-sessions'
import type {
  AnalysisNotebookOperations,
  AnalysisWorkspaceContext
} from './analysis-notebook-operations'
import { NotebookAiGenerationJobs } from './notebook-ai-generation-jobs'
import {
  buildNotebookCodeGenerationRepairPrompt,
  buildNotebookCodeGenerationPrompt,
  generatedNotebookCellsSource,
  notebookCellPromptContext,
  notebookGenerationEmptyResultMessage,
  parseFinalGeneratedNotebookCompletion,
  parseGeneratedNotebookCompletionSnapshot,
  type AnalysisNotebookCodeGenerationInput,
  type AnalysisNotebookCodeGenerationProgress,
  type AnalysisNotebookCodeGenerationResult,
  type AnalysisNotebookContextReference
} from './notebook-code-generation'
import {
  NotebookCompletionCollector,
  type NotebookCompletionSelection
} from './notebook-completion'

type RuntimeModelSelection = {
  model: RuntimeModel
  selection: ModelSelection
  migratedFrom?: ModelSelection
}

type NotebookGenerationJob = ReturnType<NotebookAiGenerationJobs['begin']>
type NotebookGenerationDocument = Parameters<typeof notebookCellPromptContext>[0]
type NotebookGenerationFile = Awaited<ReturnType<AnalysisNotebookOperations['openFile']>>
type NotebookGenerationSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>
type NotebookGenerationSession = Awaited<ReturnType<typeof createAgentSession>>['session']

type PreparedNotebookGeneration = {
  prompt: string
  workspace: AnalysisWorkspaceContext
  job: NotebookGenerationJob
  file: NotebookGenerationFile
  sessionOptions: NotebookGenerationSessionOptions
  language: string
  insertionIndex: number
  nearbyContext: string
  otherCellContext: string
  references: AnalysisNotebookContextReference[] | undefined
}

export class AnalysisNotebookCodeGenerator {
  private readonly jobs = new NotebookAiGenerationJobs()

  constructor(
    private readonly options: {
      agentDir: string
      notebooks: Pick<AnalysisNotebookOperations, 'remoteBackendFor' | 'openFile' | 'sessions'> & {
        resolveWorkspaceByCwd: (
          cwd?: string
        ) => Parameters<AnalysisNotebookOperations['remoteBackendFor']>[0] | null
      }
      notebookSessionRegistry: AnalysisNotebookSessionRegistry
      notebookExecutor: AnalysisNotebookExecutor
      models: {
        selected: () => ModelSelection | null | undefined
        thinkingLevel: () => ThinkingLevel
        resolve: (runtime: ModelRuntime, selection: ModelSelection) => RuntimeModelSelection | null
        label: (selection: ModelSelection) => string
      }
      messages: {
        extractAssistantText: (message: unknown) => string
        assistantErrorMessageFromEventSummary: (summary: PhiAgentEventSummary) => string | null
      }
    }
  ) {}

  listJobs(): ReturnType<NotebookAiGenerationJobs['list']> {
    return this.jobs.list()
  }

  async generate(
    cwd: string,
    notebookPath: string,
    document: NotebookGenerationDocument,
    input: AnalysisNotebookCodeGenerationInput,
    onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ): Promise<AnalysisNotebookCodeGenerationResult> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error('请输入要生成的代码需求')
    }

    const workspace = this.options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const modelSelection =
      input.model ?? workspace.project?.defaultModel ?? this.options.models.selected()
    const job = this.jobs.begin({
      requestId: input.requestId,
      projectCwd: workspace.workingDirectory,
      notebookPath,
      notebookName: basename(notebookPath),
      model: modelSelection ? this.options.models.label(modelSelection) : '默认模型',
      prompt
    })
    try {
      const prepared = await this.prepareGeneration({
        prompt,
        workspace,
        notebookPath,
        document,
        input,
        modelSelection,
        job
      })
      const result = await this.runPreparedGeneration(prepared, input, onProgress)
      job.complete({
        sourcePreview: result.source,
        previewCells: result.cells,
        cellCount: result.cells.length
      })
      return result
    } catch (error) {
      job.fail(error)
      throw error
    }
  }

  private async prepareGeneration(input: {
    prompt: string
    workspace: AnalysisWorkspaceContext
    notebookPath: string
    document: NotebookGenerationDocument
    input: AnalysisNotebookCodeGenerationInput
    modelSelection: ModelSelection | null | undefined
    job: NotebookGenerationJob
  }): Promise<PreparedNotebookGeneration> {
    const remote = this.options.notebooks.remoteBackendFor(input.workspace)
    const file = await this.options.notebooks.openFile(input.workspace, input.notebookPath)
    input.job.update('preparing', {
      notebookPath: file.path,
      notebookName: basename(file.path)
    })
    const runtime = await getAuthManager().getRuntime()
    const resolvedModel = input.modelSelection
      ? this.options.models.resolve(runtime, input.modelSelection)
      : null
    if (input.modelSelection && !resolvedModel) {
      throw new Error(`模型不可用: ${this.options.models.label(input.modelSelection)}`)
    }
    const { insertionIndex, nearbyContext, otherCellContext } = notebookCellPromptContext(
      input.document,
      input.input.afterCellId
    )
    const language = input.input.language || 'python'
    const references = await this.referencesWithKernelIntrospection({
      projectCwd: input.workspace.workingDirectory,
      notebookPath: file.path,
      prompt: input.prompt,
      language,
      references: input.input.references,
      sessions: this.options.notebooks.sessions(input.workspace)
    })
    const sessionCwd = remote ? this.options.agentDir : input.workspace.workingDirectory
    const sessionOptions = {
      modelRuntime: runtime,
      cwd: sessionCwd,
      noTools: 'all' as const,
      thinkingLevel:
        input.workspace.project?.defaultThinkingLevel ?? this.options.models.thinkingLevel(),
      sessionManager: createInMemoryRuntimeSessionManager(sessionCwd),
      ...(resolvedModel ? { model: resolvedModel.model } : {})
    }
    return {
      prompt: input.prompt,
      workspace: input.workspace,
      job: input.job,
      file,
      sessionOptions,
      language,
      insertionIndex,
      nearbyContext,
      otherCellContext,
      references
    }
  }

  private async runPreparedGeneration(
    prepared: PreparedNotebookGeneration,
    input: AnalysisNotebookCodeGenerationInput,
    onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ): Promise<Required<AnalysisNotebookCodeGenerationResult>> {
    const completion = new NotebookCompletionCollector()
    let eventErrorMessage = ''
    let lastProgressSource = ''
    const emitProgress = (): void => {
      lastProgressSource = emitNotebookGenerationProgress({
        completion,
        prepared,
        input,
        onProgress,
        lastProgressSource
      })
    }
    const { session } = await createAgentSession(prepared.sessionOptions, (summary) => {
      prepared.job.observe(summary)
      completion.observe(summary)
      eventErrorMessage =
        this.options.messages.assistantErrorMessageFromEventSummary(summary) ?? eventErrorMessage
      if (completion.text) prepared.job.update('generating')
      emitProgress()
    })

    try {
      prepared.job.update(
        'waiting',
        session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}
      )
      await session.prompt(
        buildNotebookCodeGenerationPrompt({
          language: prepared.language,
          notebookPath: prepared.file.relativePath,
          insertionIndex: prepared.insertionIndex,
          references: prepared.references,
          userPrompt: prepared.prompt,
          nearbyContext: prepared.nearbyContext,
          otherCellContext: prepared.otherCellContext
        }),
        {
          expandPromptTemplates: false,
          userInitiated: true,
          skipCompactionCheck: true
        }
      )
      if (eventErrorMessage) {
        throw new Error(eventErrorMessage)
      }
      return this.completeGeneration({
        prepared,
        input,
        onProgress,
        session,
        completion,
        lastProgressSource
      })
    } finally {
      await session.dispose()
    }
  }

  private async completeGeneration(input: {
    prepared: PreparedNotebookGeneration
    input: AnalysisNotebookCodeGenerationInput
    onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
    session: NotebookGenerationSession
    completion: NotebookCompletionCollector
    lastProgressSource: string
  }): Promise<Required<AnalysisNotebookCodeGenerationResult>> {
    const lastAssistantMessage = [...input.session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    const selectedCompletion = input.completion.select(
      input.prepared.language,
      parseFinalGeneratedNotebookCompletion,
      input.session.messages
    )
    let assistantText = selectedCompletion?.text || input.completion.text
    assistantText ||= this.options.messages.extractAssistantText(lastAssistantMessage).trim()
    let cells = selectedCompletion?.cells ?? []
    let completionText = assistantText
    if (cells.length === 0) {
      input.prepared.job.update('repairing')
      const repairedCompletion = await this.repairGenerationCompletion({
        sessionOptions: input.prepared.sessionOptions,
        language: input.prepared.language,
        notebookPath: input.prepared.file.relativePath,
        insertionIndex: input.prepared.insertionIndex,
        references: input.prepared.references,
        userPrompt: input.prepared.prompt,
        nearbyContext: input.prepared.nearbyContext,
        otherCellContext: input.prepared.otherCellContext,
        invalidOutput: assistantText,
        onEvent: (summary) => input.prepared.job.observe(summary),
        onProgress: (completion) => updateRepairProgress(input.prepared.job, completion)
      })
      if (repairedCompletion) {
        cells = repairedCompletion.cells
        completionText = repairedCompletion.text
      }
    }
    if (cells.length === 0) {
      const emptyResultDiagnostic =
        completionText ||
        '未收到模型返回文本或 data-notebook-cells-completion 结构化结果。请检查当前模型/供应商配置，或稍后重试。'
      throw new Error(notebookGenerationEmptyResultMessage(emptyResultDiagnostic))
    }
    const source = generatedNotebookCellsSource(cells)
    if (input.input.requestId && input.onProgress && source !== input.lastProgressSource) {
      input.onProgress({
        requestId: input.input.requestId,
        path: input.prepared.file.path,
        relativePath: input.prepared.file.relativePath,
        source,
        language: input.prepared.language,
        cells
      })
    }
    return { source, language: input.prepared.language, cells }
  }
  private async referencesWithKernelIntrospection(input: {
    projectCwd: string
    notebookPath: string
    prompt: string
    language: string
    references?: AnalysisNotebookContextReference[]
    sessions?: AnalysisNotebookSessionRegistry
  }): Promise<AnalysisNotebookContextReference[] | undefined> {
    const references = [...(input.references ?? [])]
    if (!notebookLanguageSupportsKernelIntrospection(input.language)) return references
    const variableNames = notebookAiVariableNamesFromInput(input.prompt, references)
    if (variableNames.length === 0) return references
    const target = (input.sessions ?? this.options.notebookSessionRegistry).executionTarget(
      input.projectCwd,
      input.notebookPath
    )
    if (!target) return references

    try {
      const summaries = await this.options.notebookExecutor.introspectVariables({
        connection: target.connection,
        sessionId: target.sessionId,
        kernelId: target.kernelId,
        variableNames,
        language: input.language
      })
      return summaries.reduce(mergeKernelIntrospectionReference, references)
    } catch {
      return references
    }
  }

  private async repairGenerationCompletion(input: {
    sessionOptions: NonNullable<Parameters<typeof createAgentSession>[0]>
    language: string
    notebookPath: string
    insertionIndex: number
    references?: AnalysisNotebookContextReference[]
    userPrompt: string
    nearbyContext: string
    otherCellContext: string
    invalidOutput: string
    onEvent?: (summary: PhiAgentEventSummary) => void
    onProgress?: (completion: NotebookCompletionSelection) => void
  }): Promise<NotebookCompletionSelection | null> {
    const completion = new NotebookCompletionCollector()
    let errorMessage = ''
    const { session } = await createAgentSession(input.sessionOptions, (summary) => {
      input.onEvent?.(summary)
      completion.observe(summary)
      errorMessage =
        this.options.messages.assistantErrorMessageFromEventSummary(summary) ?? errorMessage
      const snapshot = completion.select(input.language, parseGeneratedNotebookCompletionSnapshot)
      if (snapshot?.cells.length) input.onProgress?.(snapshot)
    })

    try {
      await session.prompt(
        buildNotebookCodeGenerationRepairPrompt({
          language: input.language,
          notebookPath: input.notebookPath,
          insertionIndex: input.insertionIndex,
          references: input.references,
          userPrompt: input.userPrompt,
          nearbyContext: input.nearbyContext,
          otherCellContext: input.otherCellContext,
          invalidOutput: input.invalidOutput
        }),
        {
          expandPromptTemplates: false,
          synthetic: true,
          skipCompactionCheck: true
        }
      )
      if (errorMessage) {
        throw new Error(errorMessage)
      }

      return completion.select(
        input.language,
        parseFinalGeneratedNotebookCompletion,
        session.messages
      )
    } finally {
      await session.dispose()
    }
  }
}

function emitNotebookGenerationProgress(input: {
  completion: NotebookCompletionCollector
  prepared: PreparedNotebookGeneration
  input: AnalysisNotebookCodeGenerationInput
  onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
  lastProgressSource: string
}): string {
  const selectedCompletion = input.completion.select(
    input.prepared.language,
    parseGeneratedNotebookCompletionSnapshot
  )
  if (!selectedCompletion || selectedCompletion.cells.length === 0) {
    return input.lastProgressSource
  }
  const source = generatedNotebookCellsSource(selectedCompletion.cells)
  if (source === input.lastProgressSource) return input.lastProgressSource
  input.prepared.job.update('generating', {
    sourcePreview: source,
    previewCells: selectedCompletion.cells,
    cellCount: selectedCompletion.cells.length
  })
  if (input.input.requestId && input.onProgress) {
    input.onProgress({
      requestId: input.input.requestId,
      path: input.prepared.file.path,
      relativePath: input.prepared.file.relativePath,
      source,
      language: input.prepared.language,
      cells: selectedCompletion.cells
    })
  }
  return source
}

function updateRepairProgress(
  job: NotebookGenerationJob,
  completion: NotebookCompletionSelection
): void {
  job.update('repairing', {
    sourcePreview: generatedNotebookCellsSource(completion.cells),
    previewCells: completion.cells,
    cellCount: completion.cells.length
  })
}

const NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN =
  /@(?:(?:dataframe|variable):\/\/)?((?:[A-Za-z_]|\.(?!\d))[A-Za-z0-9._]*)/g

function notebookLanguageSupportsKernelIntrospection(language: string): boolean {
  const value = language.toLocaleLowerCase()
  return value.startsWith('python') || value === 'r' || value === 'ir' || value === 'rscript'
}

function notebookAiVariableNamesFromInput(
  prompt: string,
  references: AnalysisNotebookContextReference[] | undefined
): string[] {
  const names = new Set<string>()
  for (const reference of references ?? []) {
    if (reference.kind === 'dataframe' || reference.kind === 'variable') {
      names.add(reference.name)
    }
  }
  for (const match of prompt.matchAll(NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN)) {
    names.add(match[1])
  }
  return [...names]
}

function kernelShapeLabel(shape: string | undefined): string | undefined {
  if (!shape) return undefined
  const match = shape.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/)
  return match ? `${match[1]} rows x ${match[2]} columns` : shape
}

function mergeKernelIntrospectionReference(
  references: AnalysisNotebookContextReference[],
  summary: NotebookVariableIntrospection
): AnalysisNotebookContextReference[] {
  const summaryName = summary.name
  if (!summary.exists || !summaryName) return references
  const index = references.findIndex((reference) =>
    isMatchingKernelReference(reference, summaryName)
  )
  const existing = index >= 0 ? references[index] : null
  const kind = kernelIntrospectionReferenceKind(existing, summary)
  const next: AnalysisNotebookContextReference = {
    id: existing ? existing.id : `${kind}:${summaryName}`,
    kind,
    name: summaryName,
    detail: summary.datatype ?? existing?.detail ?? 'live kernel',
    cellId: existing?.cellId,
    preview: kernelIntrospectionReferencePreview(existing, summary)
  }
  if (index < 0) return [...references, next]
  return references.map((reference, currentIndex) => (currentIndex === index ? next : reference))
}

function isMatchingKernelReference(
  reference: AnalysisNotebookContextReference,
  name: string
): boolean {
  return (
    reference.name === name && (reference.kind === 'dataframe' || reference.kind === 'variable')
  )
}

function kernelIntrospectionReferenceKind(
  existing: AnalysisNotebookContextReference | null,
  summary: NotebookVariableIntrospection
): AnalysisNotebookContextReference['kind'] {
  if (existing) return existing.kind
  return summary.columns?.length || summary.shape ? 'dataframe' : 'variable'
}

function kernelIntrospectionReferencePreview(
  existing: AnalysisNotebookContextReference | null,
  summary: NotebookVariableIntrospection
): NonNullable<AnalysisNotebookContextReference['preview']> {
  const preview = existing?.preview
  return {
    ...preview,
    source: preview?.source ?? 'live kernel',
    shape: kernelShapeLabel(summary.shape) ?? preview?.shape,
    columns: summary.columns ?? preview?.columns,
    value: summary.preview ?? preview?.value
  }
}
