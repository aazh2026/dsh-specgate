/**
 * dsh-specgate — requirement coverage for DeepSeek Harness.
 *
 * The plugin registers one tool, `specgate_cover`, which runs the deterministic
 * specgate engine over the session's working directory and reports which
 * acceptance criteria have no evidence.
 *
 * Design notes:
 *
 * - It runs inside the host process with full Node permissions and no
 *   sandbox, so it only ever *reads*. Nothing here writes to the repository.
 * - The engine (specgate-cli) is deterministic: same tree, same spec, same
 *   report. No LLM call, no network request, no API key.
 * - The working directory comes from the host's `workingDirectory` service, so
 *   the tool scans whatever directory the session is actually in rather than
 *   the launch directory.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runSpecgate, renderText, STATUS_LABEL } from 'specgate-cli'

export const name = 'specgate'

/**
 * Only `tools` is declared here.
 *
 * `workingDirectory` is deliberately NOT in `inject`: it is owned by a
 * profile bundle, and a profile-scoped plugin that waits for a service it
 * cannot see stays `pending (waiting for service: workingDirectory)` — which
 * would take the whole plugin down instead of degrading one lookup. The
 * service is therefore read lazily through `ctx.get('workingDirectory')`, and
 * a missing service falls back to the launch directory.
 */
export const inject = ['tools']

// Read the version from package.json so it can never drift from the
// published package.
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

/**
 * Resolve the directory to scan.
 *
 * Prefers the session's committed working directory (the user may have
 * `cd`-ed elsewhere during the session), and falls back to the process
 * launch directory when no agent or no service is available.
 *
 * @param ctx - host context.
 * @param exec - tool execution, carrying the agent and cancellation.
 * @returns an absolute directory path.
 */
async function resolveRoot(ctx, exec) {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined && exec.agent !== undefined) {
      const cwd = await service.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd.length > 0) {
        return path.resolve(cwd)
      }
    }
  } catch {
    // A cancelled or unavailable working directory is not fatal: the launch
    // directory still produces a useful report.
  }
  return process.cwd()
}

/**
 * Render the criteria that still need work, so the model sees the gaps
 * rather than having to re-derive them from the raw report.
 *
 * The renderer runs on the *projected* tool result, so it reads the `gaps`
 * array rather than the raw specgate report.
 *
 * @param {object} value - the tool result.
 * @returns {string} a multi-line gap summary.
 */
function renderGaps(value) {
  const gaps = value.gaps ?? []
  if (gaps.length === 0) {
    const total = value.total ?? 0
    if ((value.uncovered ?? 0) === 0 && (value.untested ?? 0) === 0 && (value.inferred ?? 0) === 0) {
      return `All ${total} acceptance criteria have evidence.`
    }
    return `No gap detail available for this report (${total} criteria).`
  }

  const lines = gaps.map((criterion) => {
    const label = STATUS_LABEL[criterion.status] ?? criterion.status
    const evidence =
      criterion.evidence === undefined || criterion.evidence === null
        ? '—'
        : `${criterion.evidence.file}:${criterion.evidence.line ?? '?'}`
    return `  ${criterion.id.padEnd(10)} ${label.padEnd(10)} ${criterion.text}\n${' '.repeat(12)}evidence: ${evidence}`
  })

  return [
    `${gaps.length} criterion/criteria without proof:`,
    ...lines,
  ].join('\n')
}

/**
 * Register the plugin's tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ maxCriteria?: number }} config - configuration from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const maxCriteria = Number.isFinite(config?.maxCriteria) ? config.maxCriteria : 50

  ctx.tools.register(defineTool({
    name: 'specgate_cover',
    description:
      'Requirement coverage for the current project: read the acceptance criteria from the spec file(s) and report which ones have no evidence in the code. ' +
      'Call this before claiming a feature is done or complete — it finds criteria that are implemented but untested, and criteria that were never implemented at all. ' +
      'Deterministic and local: no LLM call, no network, no API key. Returns a coverage score, the uncovered criteria, and the evidence for covered ones.',
    parameters: {
      spec: {
        type: 'string',
        description:
          'Optional path to an additional spec file, relative to the working directory. It is added to the spec files auto-discovered in the repository, exactly like the CLI\'s --spec flag; it does not exclude them.',
      },
      scope: {
        type: 'string',
        description:
          'Optional directory (relative to the working directory) that limits which files count as evidence. Specs are still discovered across the whole repository. Useful in a monorepo where the spec lives in one package and the implementation in another.',
      },
      verbose: {
        type: 'boolean',
        description: 'Include every criterion, not just the gaps.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          plugin: { type: 'string', required: true },
          version: { type: 'string', required: true },
          root: { type: 'string', required: true },
          score: { type: 'number' },
          total: { type: 'number' },
          covered: { type: 'number' },
          inferred: { type: 'number' },
          untested: { type: 'number' },
          uncovered: { type: 'number' },
          files_scanned: { type: 'number' },
          specs: { type: 'json' },
          gaps: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return [{ type: 'text', text: `specgate: ${value.error ?? 'scan failed'}` }]
        }
        return [{
          type: 'text',
          text: [
            `Requirement coverage: ${value.score}%  (${value.total} criteria)`,
            '',
            `  ✔ covered    ${value.covered}`,
            `  ~ inferred   ${value.inferred}`,
            `  ! untested   ${value.untested}`,
            `  ✗ uncovered  ${value.uncovered}`,
            '',
            renderGaps(value),
          ].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec)

      const specFiles = []
      if (typeof args.spec === 'string' && args.spec.length > 0) {
        specFiles.push(path.resolve(root, args.spec))
      }

      const scope = typeof args.scope === 'string' && args.scope.length > 0
        ? path.resolve(root, args.scope)
        : undefined

      let report
      try {
        report = runSpecgate({ root, specFiles, scope })
      } catch (error) {
        return {
          ok: false,
          plugin: name,
          version: VERSION,
          root,
          error: error instanceof Error ? error.message : String(error),
        }
      }

      const summary = report.summary
      const gaps = report.criteria
        .filter((c) => c.status !== 'covered')
        .slice(0, maxCriteria)
        .map((c) => ({
          id: c.id,
          status: c.status,
          text: c.text,
          file: c.file,
          evidence: c.evidence ?? null,
        }))

      return {
        ok: true,
        plugin: name,
        version: VERSION,
        root,
        score: summary.score,
        total: summary.total,
        covered: summary.covered,
        inferred: summary.inferred,
        untested: summary.untested,
        uncovered: summary.uncovered,
        files_scanned: report.stats.filesScanned,
        specs: report.specs,
        gaps,
      }
    },
  }))
}

/**
 * Exported for tests: the text rendering path used by the CLI.
 * @param {object} report - specgate report.
 * @returns {string} the CLI-style text report.
 */
export { renderText }
