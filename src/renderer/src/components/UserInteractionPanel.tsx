import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MobileStepper,
  Paper,
  Radio,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useMemo, useState } from 'react'
import { PhiIcons } from '../icons'
import type {
  AgentUserInteractionAnswer,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../types'

const StepArrowIcon = PhiIcons.action.back

type UserInteractionPanelProps = {
  request: AgentUserInteractionRequest | null
  onRespond: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
}

type DraftState = {
  requestId: string
  activeQuestionIndex: number
  selectedByQuestion: Record<number, string>
  multiByQuestion: Record<number, string[]>
  customByQuestion: Record<number, string>
}

function defaultDraft(request: AgentUserInteractionRequest): DraftState {
  const selectedByQuestion: Record<number, string> = {}
  request.questions.forEach((question, index) => {
    if (!question.multiSelect) {
      selectedByQuestion[index] = question.options[0]?.label ?? ''
    }
  })
  return {
    requestId: request.requestId,
    activeQuestionIndex: 0,
    selectedByQuestion,
    multiByQuestion: {},
    customByQuestion: {}
  }
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}

function selectedPreviews(
  request: AgentUserInteractionRequest,
  draft: DraftState,
  questionIndex: number
): string[] {
  const question = request.questions[questionIndex]
  if (!question) return []
  const selectedLabels = question.multiSelect
    ? (draft.multiByQuestion[questionIndex] ?? [])
    : [draft.selectedByQuestion[questionIndex]].filter((label): label is string => Boolean(label))
  return selectedLabels.flatMap((label) => {
    const preview = question.options.find((option) => option.label === label)?.preview
    return preview ? [preview] : []
  })
}

function answersFromDraft(
  request: AgentUserInteractionRequest,
  draft: DraftState
): AgentUserInteractionAnswer[] {
  return request.questions.map((question, questionIndex) => {
    const custom = trimmedOrUndefined(draft.customByQuestion[questionIndex])
    if (custom) {
      return {
        questionIndex,
        question: question.question,
        kind: 'custom',
        answer: custom
      }
    }

    if (question.multiSelect) {
      const selected = draft.multiByQuestion[questionIndex] ?? []
      return {
        questionIndex,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected
      }
    }

    const selected = draft.selectedByQuestion[questionIndex] ?? question.options[0]?.label ?? null
    const option = question.options.find((item) => item.label === selected)
    return {
      questionIndex,
      question: question.question,
      kind: 'option',
      answer: selected,
      ...(option?.preview ? { preview: option.preview } : {})
    }
  })
}

function UserInteractionPanel({
  request,
  onRespond
}: UserInteractionPanelProps): React.JSX.Element {
  const initialDraft = useMemo(() => (request ? defaultDraft(request) : null), [request])
  const [draftState, setDraftState] = useState<DraftState | null>(null)

  if (!request || !initialDraft || request.questions.length === 0) {
    return <></>
  }

  const draft = draftState?.requestId === request.requestId ? draftState : initialDraft
  const activeQuestionIndex = Math.min(draft.activeQuestionIndex, request.questions.length - 1)
  const activeQuestion = request.questions[activeQuestionIndex]
  const isFirstQuestion = activeQuestionIndex === 0
  const isLastQuestion = activeQuestionIndex === request.questions.length - 1
  const customValue = draft.customByQuestion[activeQuestionIndex] ?? ''
  const previews = selectedPreviews(request, draft, activeQuestionIndex)

  const updateDraft = (updater: (draft: DraftState) => DraftState): void => {
    setDraftState((current) =>
      updater(current?.requestId === request.requestId ? current : defaultDraft(request))
    )
  }

  const setActiveQuestion = (questionIndex: number): void => {
    const clamped = Math.max(0, Math.min(questionIndex, request.questions.length - 1))
    updateDraft((current) => ({ ...current, activeQuestionIndex: clamped }))
  }
  const setSingleSelection = (questionIndex: number, label: string): void => {
    updateDraft((current) => ({
      ...current,
      selectedByQuestion: { ...current.selectedByQuestion, [questionIndex]: label },
      customByQuestion: { ...current.customByQuestion, [questionIndex]: '' }
    }))
  }
  const toggleMultiSelection = (questionIndex: number, label: string): void => {
    updateDraft((current) => {
      const selected = current.multiByQuestion[questionIndex] ?? []
      const nextSelected = selected.includes(label)
        ? selected.filter((item) => item !== label)
        : [...selected, label]
      return {
        ...current,
        multiByQuestion: { ...current.multiByQuestion, [questionIndex]: nextSelected },
        customByQuestion: { ...current.customByQuestion, [questionIndex]: '' }
      }
    })
  }
  const setCustomAnswer = (questionIndex: number, value: string): void => {
    updateDraft((current) => ({
      ...current,
      customByQuestion: { ...current.customByQuestion, [questionIndex]: value }
    }))
  }

  const submit = (): void => {
    const response: AgentUserInteractionResponse = {
      requestId: request.requestId,
      answers: answersFromDraft(request, draft)
    }
    onRespond(request.requestId, response, false)
  }
  const cancel = (): void => {
    onRespond(
      request.requestId,
      { requestId: request.requestId, answers: [], cancelled: true },
      true
    )
  }

  return (
    <Paper
      variant="outlined"
      role="alert"
      aria-label="等待用户输入"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        p: 1.25,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        boxShadow: 'none'
      }}
    >
      <Stack spacing={1.25}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              需要选择
            </Typography>
          </Box>
          <Button color="inherit" size="small" onClick={cancel} sx={{ minHeight: 30 }}>
            取消
          </Button>
        </Box>

        <Stack spacing={0.75}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="primary" sx={{ fontWeight: 700, lineHeight: 1.4 }}>
              {activeQuestion.header}
            </Typography>
            {activeQuestion.multiSelect && <Chip size="small" label="多选" />}
          </Box>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {activeQuestion.question}
          </Typography>
          <Stack spacing={0.5}>
            {activeQuestion.options.map((option) => {
              const selected = activeQuestion.multiSelect
                ? (draft.multiByQuestion[activeQuestionIndex] ?? []).includes(option.label)
                : draft.selectedByQuestion[activeQuestionIndex] === option.label
              return (
                <Box
                  key={option.label}
                  sx={{
                    border: '1px solid',
                    borderColor: selected ? 'primary.main' : 'divider',
                    borderRadius: 1.25,
                    bgcolor: selected ? 'action.selected' : 'background.paper',
                    px: 0.75,
                    py: 0.25
                  }}
                >
                  <FormControlLabel
                    control={
                      activeQuestion.multiSelect ? (
                        <Checkbox
                          size="small"
                          checked={selected}
                          onChange={() => toggleMultiSelection(activeQuestionIndex, option.label)}
                        />
                      ) : (
                        <Radio
                          size="small"
                          checked={selected}
                          onChange={() => setSingleSelection(activeQuestionIndex, option.label)}
                        />
                      )
                    }
                    label={
                      <Box
                        sx={{
                          minWidth: 0,
                          py: 0.35
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
                          {option.label}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', lineHeight: 1.35, mt: 0.15 }}
                        >
                          {option.description}
                        </Typography>
                      </Box>
                    }
                    sx={{ alignItems: 'flex-start', m: 0, width: '100%' }}
                  />
                </Box>
              )
            })}
          </Stack>
          {previews.map((preview) => (
            <Box
              key={preview}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: 'action.hover',
                p: 1,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: '0.78rem'
              }}
            >
              {preview}
            </Box>
          ))}
          <TextField
            fullWidth
            size="small"
            label="自定义答案"
            value={customValue}
            onChange={(event) => setCustomAnswer(activeQuestionIndex, event.target.value)}
          />
        </Stack>

        <MobileStepper
          variant="text"
          steps={request.questions.length}
          position="static"
          activeStep={activeQuestionIndex}
          sx={{
            bgcolor: 'transparent',
            px: 0,
            py: 0,
            minHeight: 36,
            '& .MuiMobileStepper-progress': {
              mx: 2,
              minWidth: 48,
              textAlign: 'center',
              color: 'text.primary',
              fontWeight: 600
            }
          }}
          backButton={
            <Button
              size="small"
              disabled={isFirstQuestion}
              onClick={() => setActiveQuestion(activeQuestionIndex - 1)}
              startIcon={
                <StepArrowIcon sx={{ fontSize: 18, transform: 'rotate(180deg)', flexShrink: 0 }} />
              }
            >
              上一步
            </Button>
          }
          nextButton={
            isLastQuestion ? (
              <Button size="small" variant="contained" onClick={submit}>
                提交
              </Button>
            ) : (
              <Button
                size="small"
                variant="contained"
                onClick={() => setActiveQuestion(activeQuestionIndex + 1)}
                endIcon={<StepArrowIcon sx={{ fontSize: 18, flexShrink: 0 }} />}
              >
                下一步
              </Button>
            )
          }
        />
      </Stack>
    </Paper>
  )
}

export default UserInteractionPanel
