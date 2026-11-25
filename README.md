# dsh-specgate

**Requirement coverage for DeepSeek Harness.** Like test coverage, but for acceptance criteria.

[![npm](https://img.shields.io/npm/v/dsh-specgate)](https://www.npmjs.com/package/dsh-specgate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An agent that writes code fast can still leave requirements unimplemented —
and nothing in the harness notices. `dsh-specgate` gives the agent one more
instrument: before it claims a task is done, it can read the acceptance
criteria from the spec file and check which ones actually have evidence in
the code.

## Install

```bash
# into an existing profile
dsh plugin --profile web add dsh-specgate

# or from a git checkout
dsh plugin --profile web add github:aazh2026/dsh-specgate
```

Then ask the agent:

> Use the specgate tool to check requirement coverage before you finish.

## The tool

### `specgate_cover`

Reads the acceptance criteria from the spec file(s) in the session's working
directory and reports which ones have no evidence in the code.

| Parameter | Meaning |
|---|---|
| `spec` | Optional extra spec file, relative to the working directory. It is **added** to the auto-discovered ones, exactly like the CLI's `--spec` flag. |
| `scope` | Optional directory that limits which files count as evidence. Specs are still discovered across the whole repository — useful in a monorepo where the spec lives in one package and the implementation in another. |
| `verbose` | Include every criterion, not just the gaps. |

It returns the coverage score, the counts per status, the spec files it
found, and the criteria that still need proof:

```
Requirement coverage: 50%  (2 criteria)

  ✔ covered    1
  ~ inferred   0
  ! untested   0
  ✗ uncovered  1

1 criterion/criteria without proof:
  AC-2       uncovered  The system shall schedule a recurring monthly export.
            evidence: —
```

## How it works

The plugin is a thin host adapter. The matching engine is
[`specgate-cli`](https://github.com/aazh2026/specgate), which is
deterministic: same tree, same spec, same report, every time.

- **No LLM call at runtime.** The engine matches criterion ids and wording
  against code and test files by rule, not by model.
- **No network, no API key.** Everything is local file reading.
- **Read-only.** The plugin never writes to your repository. It reports; you
  decide what to fix.
- **The right directory.** The tool resolves the session's *current* working
  directory through the host's `workingDirectory` service, so it scans where
  the session actually is — not the directory the harness was launched from.

Four statuses, matching the CLI:

| Status | Meaning |
|---|---|
| `covered` | A test or source file explicitly references the criterion id. |
| `inferred` | A test name or body matches the criterion's distinctive words. |
| `untested` | Only implementation code matched — nothing pins the behaviour. |
| `uncovered` | No evidence found at all. |

## Requirements

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0`
- Node.js `>=24.9.0`

The plugin declares `@deepseek-ai/dsh-tools` as an **optional** peer
dependency: the host already provides it, and the plugin must not drag a
second copy into the profile.

## Development

```bash
npm install
npm test
```

## License

MIT
