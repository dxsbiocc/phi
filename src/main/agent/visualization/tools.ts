import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { getBundledWrapperPackagesDir } from '../wrappers/catalog'
import { runProcess, type ProcessRunner } from './process'
import { prepareTemplate } from './prepare'
import { renderFigure } from './render'
import { routeTemplates, type RouteMode } from './route'

/**
 * The mechanical half of the omics-visualization workflow as tools: profile the data and
 * shortlist templates, make a project-local copy of one, and render it and check the file.
 * Choosing among candidates and editing the copy's CONFIG stay the agent's work, done with
 * its ordinary file tools on the visible source.
 */

const SKILL_NAME = 'omics-visualization'

/** `resources/skills/omics-visualization`, beside `resources/wrappers` in dev, unpackaged and packaged builds. */
export function getBundledSkillRoot(): string {
  return join(dirname(getBundledWrapperPackagesDir()), 'skills', SKILL_NAME)
}

export interface VisualizationToolOptions {
  skillRoot?: string
  runner?: ProcessRunner
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function failure(message: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function success(
  kind: string,
  body: object
): { content: Array<{ type: 'text'; text: string }>; details: object } {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    details: { kind, ...body }
  }
}

function projectDir(ctx: CustomToolContext): string {
  return ctx.sessionManager.getCwd()
}

export function buildVisualizationTools(options: VisualizationToolOptions = {}): CustomTool[] {
  const skillRoot = options.skillRoot ?? getBundledSkillRoot()
  const run = options.runner ?? runProcess

  const route: CustomTool = {
    name: 'viz_route',
    label: 'Route Figure Templates',
    description:
      "Profile a result table and shortlist the bundled omics figure templates that fit it and the stated purpose. Returns the table's columns and up to six candidates, each with template_id, confidence, why it fits, risks, use_when / avoid_when, and a preview image path to embed as Markdown. Use it before choosing any template; never invent template ids. To show previews, embed each candidate's preview_markdown and stop for the user's choice.",
    parameters: {
      type: 'object',
      required: ['data_path', 'purpose'],
      properties: {
        data_path: {
          type: 'string',
          description: 'Absolute path of the CSV/TSV result table. It is only read.'
        },
        purpose: {
          type: 'string',
          description:
            'What the figure should show, for example "volcano plot of differential expression".'
        },
        mode: {
          type: 'string',
          enum: ['preview', 'publication'],
          default: 'preview',
          description:
            '"publication" is stricter and expects the catalog entry to be confirmed by hand.'
        },
        top: { type: 'integer', minimum: 1, maximum: 6, default: 4 },
        sidecar_dir: {
          type: 'string',
          description:
            'Directory holding companion tables such as nodes.tsv or links.tsv, when not beside the data.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const dataPath = text(record.data_path)
      const purpose = text(record.purpose)
      if (!dataPath || !purpose) return failure('data_path and purpose are required.')
      const outcome = await routeTemplates(
        {
          dataPath,
          purpose,
          ...(record.mode === 'publication' ? { mode: 'publication' as RouteMode } : {}),
          ...(typeof record.top === 'number' ? { top: record.top } : {}),
          ...(text(record.sidecar_dir) ? { sidecarDir: text(record.sidecar_dir) } : {})
        },
        skillRoot,
        run
      )
      return outcome.ok ? success('viz_route_result', outcome.result) : failure(outcome.error)
    }
  }

  const prepare: CustomTool = {
    name: 'viz_prepare',
    label: 'Prepare Figure Template',
    description:
      "Copy one bundled template into a project directory as plot.R, with its helper path already fixed, and return what to edit: the template's purpose, the tables it takes, its R dependencies, and the CONFIG and DATA PREPARATION sections with their line numbers. Edit the copy with your file tools (CONFIG for columns and labels, DATA PREPARATION for the input shape; PLOT only for structural changes), then call viz_render. An existing copy is kept with your edits unless reset is true.",
    parameters: {
      type: 'object',
      required: ['template_id', 'workdir'],
      properties: {
        template_id: {
          type: 'string',
          description: 'A template_id from viz_route, for example "scatter-volcano".'
        },
        workdir: {
          type: 'string',
          description:
            'Directory for the copy, inside the project, for example "visualizations/volcano".'
        },
        reset: {
          type: 'boolean',
          description: 'Discard an earlier copy and its edits and start again.'
        }
      }
    },
    approval: 'write',
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      const record = isRecord(params) ? params : {}
      const templateId = text(record.template_id)
      const workdir = text(record.workdir)
      if (!templateId || !workdir) return failure('template_id and workdir are required.')
      const outcome = prepareTemplate({
        skillRoot,
        cwd: projectDir(ctx),
        templateId,
        workdir,
        reset: record.reset === true
      })
      return outcome.ok ? success('viz_prepare_result', outcome.result) : failure(outcome.error)
    }
  }

  const render: CustomTool = {
    name: 'viz_render',
    label: 'Render Figure',
    description:
      'Run a prepared plot.R on the input table(s) and write the figure, then check the file. The script and the output must be inside the project; inputs may be anywhere and are only read. Returns the output path, format, size in pixels, and the QA result (failed check names). A missing R package or an R error comes back as a short message; do not install packages. A passing QA only means the file is sound: still look at the figure at final size for clipped labels, legends and misleading encodings.',
    parameters: {
      type: 'object',
      required: ['script', 'inputs', 'output'],
      properties: {
        script: { type: 'string', description: 'Path of the prepared plot.R (from viz_prepare).' },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths of the table(s) the template takes, in the order viz_prepare listed them.'
        },
        output: {
          type: 'string',
          description: 'Figure file to write: .png, .pdf or .svg, inside the project.'
        },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 900, default: 180 }
      }
    },
    approval: 'write',
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      const record = isRecord(params) ? params : {}
      const script = text(record.script)
      const output = text(record.output)
      const inputs = Array.isArray(record.inputs)
        ? record.inputs.filter(
            (item): item is string => typeof item === 'string' && item.trim() !== ''
          )
        : []
      if (!script || !output) return failure('script and output are required.')
      const cwd = projectDir(ctx)
      const outcome = await renderFigure(
        {
          skillRoot,
          cwd,
          script,
          inputs: inputs.map((input) => (isAbsolute(input) ? input : resolve(cwd, input))),
          output,
          ...(typeof record.timeout_seconds === 'number'
            ? { timeoutSeconds: record.timeout_seconds }
            : {})
        },
        run
      )
      return outcome.ok ? success('viz_render_result', outcome.result) : failure(outcome.error)
    }
  }

  return [route, prepare, render]
}
