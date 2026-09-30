import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'
import { isAbsolute, join, resolve } from 'node:path'

import { bundledPluginsDir } from '../plugins/bundled'
import { findFigureExamples } from './examples'
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

/** `resources/plugins/visualization/skills/omics-visualization` in dev, unpackaged, and packaged builds. */
export function getBundledSkillRoot(): string {
  return join(bundledPluginsDir(), 'visualization', 'skills', SKILL_NAME)
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

  const examples: CustomTool = {
    name: 'viz_examples',
    label: 'Show Installed Figure Examples',
    description:
      "Find real preview.png images already shipped with omics-visualization templates. Use when the user asks to see examples or styles without providing a data table. This reads the installed catalog and images; it does not create sample data, simulate a plot, render a new figure, or write to the project. Embed the returned preview_markdown images unchanged and explain that they are template examples, not plots of the user's data.",
    parameters: {
      type: 'object',
      required: ['purpose'],
      properties: {
        purpose: { type: 'string', description: 'Chart family or visual purpose to preview.' },
        top: { type: 'integer', minimum: 1, maximum: 4, default: 4 }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const purpose = text(record.purpose)
      if (!purpose) return failure('purpose is required.')
      try {
        const top = typeof record.top === 'number' ? record.top : 4
        return success('viz_examples_result', findFigureExamples(skillRoot, purpose, top))
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const route: CustomTool = {
    name: 'viz_route',
    label: 'Route Figure Templates',
    description:
      "For new figure selection, profile a result table and shortlist bundled omics templates that fit its purpose. Returns columns and up to six candidates with template_id, fit, risks, and preview_markdown. Use it before choosing a new template; never invent template ids. Do not call it for a small revision of an existing prepared script. To show previews, embed each candidate's preview_markdown and stop for the user's choice.",
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
      'For a newly selected template, copy its plot.R into the project and return the input contract and editable CONFIG/DATA PREPARATION sections. Edit the copy, then call viz_render. For a revision of an existing prepared plot.R, read and edit that project copy directly; do not copy or reset the bundled template. An existing copy is kept with its edits unless reset is true.',
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

  return [examples, route, prepare, render]
}
