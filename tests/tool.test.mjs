// Unit tests for dsh-specgate.
//
// The tool is exercised against a fake context that records the registered
// tool, then executed directly with synthetic arguments. No DSH host, no
// network, and no real repository are involved: the coverage fixture is
// written into a temp directory by the test itself.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const captured = []

const ctx = {
  tools: {
    register(tool) {
      captured.push(tool)
      return () => {}
    },
  },
  get() {
    return undefined
  },
  logger: {
    warn: (message) => console.warn('[warn]', message),
  },
}

const { apply, name, inject, VERSION } = await import('../src/index.js')

apply(ctx, { maxCriteria: 50 })

const tool = captured.find((t) => t.name === 'specgate_cover')
assert.ok(tool, 'the plugin must register specgate_cover')
assert.equal(name, 'specgate')
assert.deepEqual(inject, ['tools'])

/**
 * Write a small project with one covered and one uncovered criterion.
 * @returns {Promise<string>} the project root.
 */
async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-specgate-'))
  await writeFile(
    join(root, 'SPEC.md'),
    [
      '# Demo spec',
      '',
      '## AC-1 Export invoices',
      '- AC-1: The system shall export invoices as CSV.',
      '',
      '## AC-2 Recurring export',
      '- AC-2: The system shall schedule a recurring monthly export.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'test'), { recursive: true })
  await writeFile(
    join(root, 'test', 'export.test.js'),
    ['// AC-1', "test('export invoices as CSV', () => {})", ''].join('\n'),
  )
  return root
}

const root = await makeProject()

// Without an agent the tool falls back to the launch directory, which is how
// a non-agent call resolves its root. Move into the fixture project so the
// scan sees the fixture's SPEC.md and test file.
const previousCwd = process.cwd()
process.chdir(root)

try {
  // --- the tool returns a coverage report -----------------------------------
  const result = await tool.execute(
    { verbose: false },
    { signal: new AbortController().signal },
  )

  assert.equal(result.ok, true)
  assert.equal(result.plugin, 'specgate')
  assert.equal(result.version, VERSION)
  assert.equal(result.total, 2)
  assert.equal(result.covered, 1)
  assert.equal(result.uncovered, 1)
  assert.equal(result.score, 50)
  assert.ok(result.files_scanned >= 1, 'the test file must be scanned')

  // The gap list carries the uncovered criterion and nothing else.
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].id, 'AC-2')
  assert.equal(result.gaps[0].status, 'uncovered')
  assert.equal(result.gaps[0].evidence, null)

  // --- the rendered output is model-facing text -----------------------------
  const rendered = tool.output.render({}, result)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Requirement coverage: 50%/)
  assert.match(rendered[0].text, /AC-2/)
  assert.match(rendered[0].text, /uncovered/)

  // --- an explicit spec path is honoured -----------------------------------
  const explicit = await tool.execute(
    { spec: 'SPEC.md' },
    { signal: new AbortController().signal },
  )
  assert.equal(explicit.ok, true)
  assert.equal(explicit.total, 2)

  // --- a spec path that does not exist is ignored, not a crash -------------
  // The engine treats explicit spec paths as additive to the auto-discovered
  // ones, and skips paths that are not files — the same as the CLI.
  const missing = await tool.execute(
    { spec: 'does-not-exist.md' },
    { signal: new AbortController().signal },
  )
  assert.equal(missing.ok, true)
  assert.equal(missing.total, 2)

  // --- the gap list respects maxCriteria ------------------------------------
  const limited = { ...ctx }
  const limitedCaptured = []
  limited.tools = { register: (t) => { limitedCaptured.push(t); return () => {} } }
  const { apply: applyLimited } = await import('../src/index.js')
  applyLimited(limited, { maxCriteria: 0 })
  const limitedTool = limitedCaptured.find((t) => t.name === 'specgate_cover')
  const limitedResult = await limitedTool.execute(
    {},
    { signal: new AbortController().signal },
  )
  assert.equal(limitedResult.gaps.length, 0, 'maxCriteria: 0 must return no gaps')
  assert.equal(limitedResult.uncovered, 1, 'the summary still counts every gap')

  console.log('ok — dsh-specgate tool behaviour')
} finally {
  process.chdir(previousCwd)
  await rm(root, { recursive: true, force: true })
}
