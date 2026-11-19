// Optional deterministic model for UI regression. It has no filesystem, IPC, or plugin access.
// Every observation comes back over the normal model transport from a real Phi tool.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { basename, resolve } from 'node:path'

const modelId = 'deseq2-regression'
const taskPrefix = 'Regression task inputs: '

function content(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => part.text ?? '').join('\n')
}

function toolCalls(messages) {
  const answers = new Map(
    messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, content(m)])
  )
  return messages
    .flatMap((m) =>
      (m.tool_calls ?? []).map((t) => ({
        name: t.function.name,
        args: JSON.parse(t.function.arguments || '{}'),
        output: answers.get(t.id)
      }))
    )
    .filter((c) => typeof c.output === 'string')
}

function jsonResult(value) {
  const start = value.indexOf('{')
  // Script tools can append a warnings section. A specialist's compact report can have a status prefix.
  assert(start >= 0, 'A real tool returned no parseable structured result')
  // Phi appends its own reporting instructions to delegated prompts. These may also contain JSON.
  for (let end = value.indexOf('}', start + 1); end !== -1; end = value.indexOf('}', end + 1)) {
    try {
      return JSON.parse(value.slice(start, end + 1))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  throw new Error('Incomplete JSON result from the desktop tool')
}

function handoff(answer, evidence, extra = {}) {
  const {
    question,
    rationale = 'Based on the installed tool output.',
    interpretation = answer
  } = extra
  const result = {
    status: question ? 'blocked' : 'completed',
    missingInputs: question ? ['Sample-to-donor mapping'] : [],
    research: {
      subquestion: 'What does this step establish for the requested contrast?',
      answer,
      interpretation,
      rationale,
      evidence,
      ...(question ? { question } : {})
    }
  }
  return { text: '<phi_agent_result>' + JSON.stringify(result) + '</phi_agent_result>' }
}

function specialist(task, calls, invoke) {
  const previous = calls.at(-1)
  switch (task.step) {
    case 'preflight': {
      if (!previous) return invoke('de_preflight', task.args)
      assert.equal(previous.name, 'de_preflight')
      const result = jsonResult(previous.output)
      if (result.status === 'needs_input') {
        assert(result.question)
        return handoff(result.reasons.join(' '), [task.args.metadata], {
          question: result.question
        })
      }
      assert.equal(result.status, 'ok')
      assert(result.wrapper_params)
      return handoff('The sample design passed preflight.', [task.args.metadata], {
        rationale: JSON.stringify(result.wrapper_params)
      })
    }
    case 'launch': {
      if (!previous) return invoke('wrapper_search', { query: 'deseq2' })
      const id = 'local/modules/differential-expression-deseq2'
      if (previous.name === 'wrapper_search') {
        assert(
          previous.output.includes(id),
          'Wrapper catalog did not return DESeq2: ' + previous.output.slice(0, 200)
        )
        return invoke('wrapper_inspect', { id })
      }
      if (previous.name === 'wrapper_inspect') {
        assert.equal(jsonResult(previous.output).id, id)
        return invoke('wrapper_run', { id, profile: 'docker', target: 'local', params: task.args })
      }
      assert.equal(previous.name, 'wrapper_run')
      const run = previous.output.match(/Started wrapper run (wrun_[a-z0-9-]+)/i)
      assert(run, 'Wrapper failed to launch: ' + previous.output.slice(0, 250))
      return handoff('Run started: ' + run[1], [run[1]], {
        rationale: 'Await the Phi completion notice.'
      })
    }
    case 'outputs': {
      if (!previous) return invoke('wrapper_status', { run_id: task.runId })
      assert.equal(previous.name, 'wrapper_status')
      assert.match(previous.output, /State: completed/)
      assert.match(previous.output, /result MD5 verified/)
      const paths = ['results', 'research_qc'].map((id) => {
        const match = previous.output
          .split('\n')
          .find((line) => line.startsWith('- ' + id + ': ') && line.endsWith('(primary, present)'))
        assert(match, 'Missing verified ' + id)
        return match.slice(id.length + 4, -' (primary, present)'.length)
      })
      return handoff('DESeq2 completed and both primary outputs are present.', paths)
    }
    case 'assessment': {
      if (!previous) return invoke('de_assess', task.args)
      assert.equal(previous.name, 'de_assess')
      const { status, disposition, evaluated, hits, padjThreshold, log2fcThreshold } = jsonResult(
        previous.output
      )
      assert.equal(status, 'ok')
      assert(['eligible', 'skip'].includes(disposition) && evaluated > 0)
      assert.equal(hits === 0, disposition === 'skip')
      return handoff(
        `共评估 ${evaluated} 个基因，${hits} 个达到阈值（padj < ${padjThreshold}，|log2FC| ≥ ${log2fcThreshold}）。`,
        Object.values(task.args),
        {
          rationale: disposition,
          interpretation:
            disposition === 'skip'
              ? '没有符合阈值的差异基因作为候选列表，已跳过富集分析。'
              : '差异基因列表可以用于已批准的富集分析。'
        }
      )
    }
    case 'ora': {
      if (!previous) return invoke('de_ora', task.args)
      assert.equal(previous.name, 'de_ora')
      const result = jsonResult(previous.output)
      assert.equal(result.status, 'ok')
      assert(result.outputs?.some((entry) => entry.id === 'ora'))
      return handoff(
        `富集分析已完成，检验 ${result.terms_tested} 个基因集，其中 ${result.terms_q05} 个达到校正后的显著性阈值。`,
        [task.args.out]
      )
    }
    default:
      throw new Error('Unknown regression specialist task')
  }
}

function leader(profile, users, calls, invoke) {
  const original = users.find(
    (s) => /(?:paired|zero)\/counts\.tsv/.test(s) && !s.includes(taskPrefix)
  )
  assert(original, 'No desktop study prompt with synthetic input paths found')
  const key = original.includes('paired/counts.tsv') ? 'paired' : 'zero'
  const paths = profile[key]
  const question = original
    .match(/[^<>\n]*?[？?]/gu)
    ?.find((q) => q.includes('差异表达'))
    ?.trim()
  assert(question, 'The desktop research question could not be bound to the actual user prompt')
  function delegate(agent, task) {
    return invoke(agent, { research_question: question, task: taskPrefix + JSON.stringify(task) })
  }
  const preflight = (metadata) =>
    delegate('DifferentialExpression', {
      step: 'preflight',
      args: {
        metadata,
        design: 'paired',
        sample_id_col: 'sample',
        condition_col: 'condition',
        donor_col: 'donor',
        reference_level: 'control',
        target_level: 'treated'
      }
    })
  const last = calls.at(-1)
  if (!last) return preflight(paths.metadata)
  if (last.name === 'ask_user_question') {
    const userAnswer = last.output + '\n' + users.slice(1).join('\n')
    const corrected = userAnswer.match(/paired\/corrected-samples\.tsv/)
    if (corrected) return preflight(resolve(profile.project, corrected[0]))
    return { text: '请提供补齐供体列的样本表路径，以继续配对分析。' }
  }
  const report = jsonResult(last.output)
  if (report.question && report.status === 'blocked')
    return invoke('ask_user_question', { questions: [report.question] })
  assert.equal(report.status, 'completed', 'Specialist produced no verified handoff')
  const task = jsonResult(last.args.task)
  switch (task.step) {
    case 'preflight':
      return delegate('Wrapper', {
        step: 'launch',
        args: {
          ...JSON.parse(report.rationale),
          padj_threshold: 0.05,
          log2fc_threshold: 1,
          samplesheet: task.args.metadata,
          counts: paths.counts,
          outdir: paths.outdir,
          prefix: 'screen'
        }
      })
    case 'launch': {
      const runId = report.answer.match(/wrun_[a-z0-9-]+/i)?.[0]
      assert(runId)
      const notice = users.find(
        (s) => s.includes('<phi_wrapper_run_finished>') && s.includes(runId)
      )
      if (!notice) return { text: '本地差异表达分析已启动，完成后会核验结果。' }
      assert.match(notice, /Research QC (?:eligible|skip)/)
      return delegate('Wrapper', { step: 'outputs', runId })
    }
    case 'outputs': {
      const [results, qc] = report.evidence
      assert(results && qc)
      return delegate('DifferentialExpression', { step: 'assessment', args: { results, qc } })
    }
    case 'assessment': {
      if (report.rationale === 'skip') {
        return {
          text: `${report.answer} ${report.interpretation}\n\n[差异分析结果](${report.evidence[0]})`
        }
      }
      assert.equal(report.rationale, 'eligible')
      assert(
        original.includes('富集') && original.includes(basename(paths.enrichment)),
        'ORA output was not requested'
      )
      return delegate('DifferentialExpression', {
        step: 'ora',
        args: { ...task.args, gmt: paths.geneSets, out: paths.enrichment }
      })
    }
    case 'ora': {
      const assessment = calls.find((c) => c.args.task?.includes('"step":"assessment"'))
      assert(assessment)
      const verified = jsonResult(assessment.output)
      return {
        text: `${verified.answer} ${report.answer}\n\n[差异分析结果](${verified.evidence[0]}) [富集结果](${report.evidence[0]})`
      }
    }
    default:
      throw new Error('Missing regression handoff')
  }
}

function nextReply(profile, body, trace) {
  const { messages, tools = [] } = body
  const names = tools.map((t) => t.function.name)
  const users = messages.filter((m) => m.role === 'user').map(content)
  if (!names.length && users.at(-1)?.includes('Create a short, specific title'))
    return { text: '差异表达分析' }
  if (!names.length && messages.some((m) => content(m).includes('Is this specialist suitable')))
    return { text: 'suitable' }
  const calls = toolCalls(messages)
  function invoke(name, args) {
    assert(
      names.includes(name),
      'Required production tool ' + name + ' is unavailable (exposed: ' + names.join(', ') + ')'
    )
    return { tool: { id: 'call_' + randomUUID().replaceAll('-', ''), name, args } }
  }
  const task = users.find((s) => s.includes(taskPrefix))
  const reply = task
    ? specialist(jsonResult(task.slice(task.indexOf(taskPrefix))), calls, invoke)
    : leader(profile, users, calls, invoke)
  const last = calls.at(-1)
  // Count completed domain tools independently of collapsed specialist UI messages.
  const verified = task && last?.name.startsWith('de_') ? jsonResult(last.output) : undefined
  trace.push({
    actor: task ? 'specialist' : 'main',
    action: reply.tool?.name ?? 'reply',
    ...(verified
      ? { returnedTool: last.name, returnedStatus: verified.disposition ?? verified.status }
      : {})
  })
  return reply
}

export async function startRegressionProvider(profile) {
  const token = randomBytes(24).toString('hex')
  const trace = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
        return res.writeHead(404).end()
      if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end()
      let input = ''
      for await (const chunk of req) {
        input += chunk
        assert(input.length <= 4 * 1024 * 1024, 'Regression model request too large')
      }
      const reply = nextReply(profile, JSON.parse(input), trace)
      const id = randomUUID()
      function frame(delta, finish_reason = null) {
        res.write(
          'data: ' +
            JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta, finish_reason }]
            }) +
            '\n\n'
        )
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      frame({ role: 'assistant' })
      if (reply.tool)
        frame({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id,
              type: 'function',
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) }
            }
          ]
        })
      else frame({ content: reply.text })
      frame({}, reply.tool ? 'tool_calls' : 'stop')
      res.end('data: [DONE]\n\n')
    } catch (error) {
      const diagnostic = error.message.slice(0, 650)
      trace.push({ error: diagnostic })
      console.error('Desktop regression provider:', diagnostic)
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: diagnostic } }))
    }
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    modelId,
    token,
    trace,
    close: async () => {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  }
}
