# How to write a DeepSeek Harness tool plugin

A field guide for people writing a tool plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), written
while building [`dsh-specgate`](https://github.com/aazh2026/dsh-specgate).

Every rule below was **measured against a real DSH boot** (`0.2.2-rc.5`), not
read off the docs. Where my first guess turned out to be wrong, the guide says
so — those are the parts that cost the most time.

The official references are
[Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)
and the
[tool authoring reference](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cookbook/adding-a-tool.md).
Read those for the contract; read this for the parts that bite.

---

## 1. The two manifests

A **bundle** is an npm package you distribute. A **profile** is a directory
under `$DSH_HOME/profiles/<name>` describing one runnable composition.

| | Manifest key | Answers |
|---|---|---|
| Bundle | `dsh.bundle` | "What does this package contribute?" |
| Profile | `dsh.profile` | "Which bundles compose this setup, in what order?" |

Nothing is both. A bundle's `package.json`:

```json
{
  "name": "dsh-specgate",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "files": ["src", "cordis.patch.yml", "README.md", "LICENSE"],
  "engines": {
    "node": ">=24.9.0",
    "dsh": ">=0.2.0-rc.2 <0.3.0-0"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` is the layer the bundle contributes:

```yaml
- insert:
    - id: specgate
      name: 'dsh-specgate'
      config:
        maxCriteria: 50
```

> **Declare `engines.dsh`.** Without it, installation falls back to checking
> your `@deepseek-ai/dsh*` peer dependency ranges. With it, the range is
> stated plainly and a mismatched DSH refuses the bundle at install time
> instead of failing obscurely later. I added it after reading the official
> publish guide and confirming it did not change install behaviour on
> `0.2.2-rc.5`.

---

## 2. `inject` is a hard dependency, not a hint

This is the rule I got wrong first, so it goes first.

```js
export const inject = ['tools']
```

`inject` lists services the host must provide **before** `apply()` runs. The
host resolves them at activation; an entry whose declared services never
appear is never activated at all.

Measured, with a deliberately unprovided service:

```js
export const inject = ['tools', 'thisServiceDoesNotExist']
```

```
trap (dsh-trap-inject): pending (waiting for service: thisServiceDoesNotExist)
registered tools: 29
has trap_tool: false
```

The plugin never activated, and **its tool never registered** — the model
would not see the tool, and there is no "degraded" mode.

### The part I assumed wrong

I had written in my own plugin's source comment that declaring
`workingDirectory` in `inject` would leave the plugin pending forever,
because the service is owned by a profile bundle. That is false:

```js
export const inject = ['tools', 'workingDirectory']   // works fine
```

```
bundles: @deepseek-ai/dsh-base, dsh-trap-inject
[trap] apply() ran; workingDirectory service = PRESENT
has trap_tool: true
```

The provider `@deepseek-ai/dsh-working-directory` ships **inside
`@deepseek-ai/dsh-base`**, and every profile lists `dsh-base` first. So the
service is there.

The real reason to keep a service out of `inject` is the one the experiment
above actually demonstrates: declaring a service you cannot guarantee turns a
soft degradation into a hard disappearance. `ctx.get('workingDirectory')` at
call time, with a fallback, degrades **one lookup**; a pending entry loses
**the whole tool**.

### When to use which

| Situation | Use |
|---|---|
| Service always present (host core, `dsh-base`) | `inject` — fail fast, clear diagnostics |
| Service may be absent (optional bundle, profile-dependent) | `ctx.get(...)` lazily, with a fallback |

---

## 3. Services resolve at different times — and it matters

With `inject: ['tools', 'workingDirectory']`:

```js
export function apply(ctx) {
  const atApply = ctx.get('workingDirectory')
  // at apply() time: UNDEFINED
}

ctx.tools.register(defineTool({
  // ...
  async execute(args, exec) {
    const atExec = ctx.get('workingDirectory')
    // at execute() time: PRESENT
  }
}))
```

Measured output:

```
[trap] apply-time workingDirectory = UNDEFINED
{"ok":true,"error":"exec:PRESENT"}
```

**A service you declared in `inject` is not readable during `apply()`.** The
host binds it as part of activating the entry; `apply()` runs before that
binding is visible through `ctx.get`.

If your tool needs the service, read it inside `execute()` — which is where
you need it anyway, because the session's working directory can change
during a session.

---

## 4. The output schema is enforced — and the DSL is stricter than JSON Schema

`output.schema` is validated by the host against the value `execute()`
returns. Violations surface as tool errors.

### `additionalProperties` must be explicit

```js
schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
// JsonSchemaError: unsupported JSON schema: schema.additionalProperties
// must be explicitly true or false
```

### `required` is a per-property flag in the DSL, not an array

This trips people coming from raw JSON Schema. The **object-level** `required`
array is rejected:

```js
schema: { type: 'object', additionalProperties: false,
          properties: { ok: { type: 'boolean' } }, required: ['ok'] }
// JsonSchemaError: schema.required is not supported by the value schema DSL
```

The DSL wants the flag on the property:

```js
schema: {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok:     { type: 'boolean', required: true },
    plugin: { type: 'string',  required: true },
    error:  { type: 'string' },        // optional
  },
}
```

`defineTool` compiles that into the object-level form the validator runs:

```json
{"type":"object","additionalProperties":false,
 "properties":{"ok":{"type":"boolean"},"error":{"type":"string"}},
 "required":["ok"]}
```

And it is enforced:

```
missing ok        -> ["missing required property \"value.ok\""]
undeclared key    -> ["\"value.boom\" is not a declared property (additionalProperties: false)"]
```

> **Consequence for error paths.** With `additionalProperties: false`, an
> error return must still fit the schema. Declare `error` as an *optional*
> property rather than loosening the schema — the success and failure paths
> then share one shape, and the host validates both.

### `type: 'json'` for free-form payloads

There is no `object`/`array`/`string` union you need for arbitrary JSON. The
DSL has a `json` type:

```js
properties: { specs: { type: 'json' }, gaps: { type: 'json' } }
```

compiles to `{"specs":{},"gaps":{}}` and accepts any JSON value.

---

## 5. `output.render` gets the value, not the report

`output.render(args, value)` receives the **canonical value** your
`execute()` returned — the same object the host validated. It does not
receive your internal report object.

If you build a big internal report and only want to expose a slice, project
the slice explicitly in `execute()`:

```js
const gaps = report.criteria
  .filter((c) => c.status !== 'covered')
  .slice(0, maxCriteria)
  .map((c) => ({ id: c.id, status: c.status, text: c.text, evidence: c.evidence ?? null }))

return { ok: true, score, total, covered, inferred, uncovered, gaps }
```

then render from `value.gaps`. Reaching back into `report` from `render`
works right up until the day you change the projection.

---

## 6. Optional peer dependencies, not dependencies

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0-0"
},
"peerDependenciesMeta": {
  "@deepseek-ai/dsh-tools": { "optional": true }
}
```

The host already provides `dsh-tools`. Listing it as a plain `dependency`
drags a **second copy** into the profile, and then `instanceof` checks and
service identity can diverge from the host's.

Keep independently versioned third-party code in `dependencies`. Put anything
whose instance must be shared with the host in `peerDependencies` **and**
`devDependencies` (the dev copy is for your type checker and tests).

---

## 7. Installing: three routes, all measured

### From GitHub (sources, not artifacts)

```bash
dsh plugin --profile demo add github:you/your-plugin
```

This fetches **sources**. Nothing runs your `build` script, so a TypeScript
package arrives without its `lib/` and fails to load. Either ship a `prepare`
script that builds the entry points, or ship prebuilt artifacts.

### From npm

```bash
dsh plugin --profile demo add your-plugin
```

Installs prebuilt code. No build permission needed.

### From a tarball

```bash
dsh plugin --profile demo add \
  https://github.com/you/your-plugin/releases/latest/download/your-plugin-0.1.0.tgz
```

Also prebuilt, also no build permission. **This is the route to use when you
cannot publish to npm yet** — it needs no registry, no 2FA, no token, and it
works offline from a release asset.

All three were verified end-to-end on `0.2.2-rc.5`: bundle mounts, tool
registers, tool executes, model-facing schema is valid.

---

## 8. Verify in a real boot — a unit test proves nothing

A unit test with a fake `ctx` cannot prove a bundle mounts. The DSH launcher
exposes the same entry it uses, so you can boot the real composition and
inspect the host's own registries.

```js
import { boot, readProfilePatches, loadProfile, PluginPackages, createRuntimeResolution }
  from '@deepseek-ai/dsh-app-boot'

const installAnchor = '/path/to/dsh/node_modules/@deepseek-ai/dsh/package.json'
const profile = loadProfile('dsh', PROFILE, installAnchor, HOME)
const profileContext = {
  name: PROFILE, packageManager: 'pnpm', dir: profileDir,
  patchPath: profile.patchPath, installAnchor,
  startedBundles: profile.layers.map((l) => l.packageName),
  cwd: process.cwd(), home: HOME, overlays: [], telemetryDisabledEnv: true,
}

const patches = readProfilePatches('dsh', profileContext, profile)
const resolution = await createRuntimeResolution({ installAnchor, profile, home: HOME })

const ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches, async (hostCtx) => {
  hostCtx.provide('profileContext', profileContext)
  await hostCtx.plugin(PluginPackages, { resolution })
})

const names = ctx.tools.definitions().map((d) => d.name)
const tool = ctx.tools.get('your_tool')
const value = await tool.execute({}, { signal: new AbortController().signal, arguments: {} })
const schemas = ctx.tools.schemas()
await ctx.fiber.dispose()
```

Four things to assert:

1. `ctx.tools.definitions()` contains your tool name.
2. `ctx.tools.get('your_tool')` returns a definition.
3. `tool.execute(...)` returns the value you expect.
4. `ctx.tools.schemas()` contains a model-facing entry for it.

Two gotchas while writing this:

- **`hostCtx.plugin(PluginPackages, { resolution })` is required.** Without
  the `resolution` option, bare package names in the config tree cannot
  resolve against the DSH installation and *every* entry fails to import.
- **`ctx.start()` does not exist.** Cordis plugins are mounted with
  `await ctx.plugin(X)`. `ctx.stop()` does not exist either; tear down with
  `ctx.fiber.dispose()`.

The full script for `dsh-specgate` lives at
[`verify-plugin.mjs`](https://github.com/aazh2026/dsh-specgate) — it prints
the registered tool count, the tool's description, a real execution result,
the rendered output, and whether the model-facing schema is present.

---

## 9. Checklist before you publish

- [ ] `dsh.bundle.patch` points at a patch file that is actually in `files`
- [ ] `engines.dsh` declares the supported range
- [ ] `inject` lists only services you can guarantee
- [ ] Any optional service is read lazily inside `execute()`, with a fallback
- [ ] `output.schema` sets `additionalProperties` explicitly
- [ ] `required` is a per-property flag, not an object-level array
- [ ] The error return path fits the same schema as the success path
- [ ] `output.render` reads only the returned value
- [ ] Host-shared packages are optional `peerDependencies`
- [ ] Verified in a real boot: tool registered, executed, schema model-facing
- [ ] At least one install route that needs no registry access
- [ ] Repo has the `dsh-plugin` topic, so the ecosystem list can find it

---

## Contributing back

The harness repository does not accept external pull requests yet — its
`CONTRIBUTING.md` points contributors at Discussions, plugins, and guides
instead. So:

- Post the plugin in
  [Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins)
- Tag the repo `dsh-plugin` so the ecosystem list can find it
- Open a PR against the ecosystem list
  ([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin))
  — note that it requires the repository to be at least one day old, and that
  check re-runs by itself

If this guide saves you time, or if a rule here turns out to be wrong for your
version of DSH, say so in a Discussion. Corrections are worth more than
agreement.
