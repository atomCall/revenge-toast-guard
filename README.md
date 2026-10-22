# Toast Guard

A [Revenge](https://revenge-mod.dev) plugin that stops the Discord Android crash:

```
TypeError: Cannot read property 'position' of undefined
  at useToastContainer (index.android.bundle)
```

It ships both plugin formats, because "Revenge" is currently two different
plugin systems:

| Build | Who runs it | What it fetches |
| --- | --- | --- |
| Revenge **legacy** (Vendetta, and the Bunny/Pyon forks) | the stable app | `<url>/manifest.json`, then `<url>/dist/legacy.js` |
| Revenge **Next** | the rewrite | a repository root with `index.json` + a zip per version |

## Install

### Revenge legacy (stable)

Settings → **Plugins** → install from URL, using the repository root:

```
https://raw.githubusercontent.com/atomCall/revenge-toast-guard/main/
https://atomcall.github.io/revenge-toast-guard/
```

Revenge appends `manifest.json` to that URL, then resolves `main`
(`dist/legacy.js`) relative to it. The trailing slash is optional.

> *"Failed to fetch manifest for …"* is this loader's error: `<url>/manifest.json`
> did not come back as JSON. The `github.com/...` page is HTML, and a URL that
> already ends in `manifest.json` gets a second `manifest.json` appended.

### Revenge Next

Add one of these as a **plugin repository** (it must serve `index.json`):

```
https://atomcall.github.io/revenge-toast-guard
https://raw.githubusercontent.com/atomCall/revenge-toast-guard/main
```

Then enable **Toast Guard** in the plugin list. Its settings page toggles each
layer individually; the defaults protect everything.

Manual install: for Revenge legacy, place `dist/legacy.js` as `index.js` next to
a copy of `manifest.json` in `/sdcard/Revenge/plugins/attard.toast-guard/`; for
Revenge Next, unzip `pool/attard.toast-guard@1.0.0.zip` into the same folder.

What gets published:

```
manifest.json                  Revenge legacy manifest (authors / main / hash)
dist/legacy.js                 Revenge legacy bundle, a `vendetta => {…}` expression
index.json                     Revenge Next repository index (format 1) + sha256
pool/<id>@<version>.zip        Revenge Next artifact: manifest.json + index.js
dist/index.js                  Revenge Next bundle
dist/manifest.json             Revenge Next metadata, script relative to dist/
plugin.json                    source of truth for the Next metadata
```

To rebuild after a change:

```bash
bun install
bun run check     # typecheck + build + tests
```

## Why it crashes

Discord's own `useToastContainer` reads `position` off every entry of its toast
list. If the list ever contains an entry that is `undefined` (a dismiss/remove
racing a render, or a queued toast that was never given a `position`), that read
throws and takes down the whole screen that renders the container.

Toast Guard fixes the data **and** the read:

| Layer | What it does | Where |
| --- | --- | --- |
| 1. Source | Fills a missing `position` on toast payloads before Discord enqueues them (`showToast` & friends) | `ensurePosition()` |
| 2. Hook | Wraps `useToastContainer`, drops unusable entries, repairs handlers, and on a throw returns the last good state instead of propagating | `guardToastState()` |
| 3. Component | If the hook cannot be found, wraps `ToastContainer` so a render throw renders nothing instead of crashing | `index.ts` |

Nothing is hardcoded to a module ID: the modules are discovered by their
exported props (`useToastContainer`, `ToastContainer`, `showToast`, ...), so the
plugin survives Discord updates that renumber modules.

## Behaviour details

- An entry is kept if it is a non-array object with a non-empty string/numeric
  `id`. Everything else is dropped and logged.
- A toast missing `position` inherits the position of a valid sibling; if there
  is none it gets `bottom`.
- Duplicate ids keep the newest entry (a stale entry surviving a removal is the
  most common shape of this bug).
- `handlers.updateHeight` / `startPause` / `endPause` / `calculateOffset` always
  exist, so a partially initialised container cannot throw either.
- A throwing `useToastContainer` is contained: the container renders the last
  good state (or an empty one) and the error is logged once.
- Disabling a setting takes effect immediately; disabling the plugin reloads
  Discord so the patches are fully removed.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Guard the toast container | on | Layer 2 + 3 |
| Fix toasts at the source | on | Layer 1 |
| Log dropped toasts | on | Writes to the React Native log (capped at 20 lines) |

## Build

```bash
bun install
bun run check     # typecheck + tests + build
```

## Build output

`bun run build` compiles both bundles and regenerates every published artifact
described in [Install](#install):

```
dist/index.js          Revenge Next bundle (ESM, @revenge-mod/* external)
dist/manifest.json     Revenge Next manifest, script relative to dist/
dist/legacy.js         Revenge legacy bundle (single expression, nothing imported)
manifest.json          Revenge legacy manifest, hash of dist/legacy.js
pool/<id>@<version>.zip
index.json
```

`dist/legacy.js` and `manifest.json` are reproducible: the legacy bundle is
byte-identical across builds, which is what keeps the committed `hash` (and the
zip `sha256` in `index.json`) valid after a rebuild.

## Diagnosing

```bash
adb logcat -s ReactNativeJS | grep ToastGuard
```

On start you should see:

```
[ToastGuard] active (hook: true, component: false, dispatchers: 2)
```

- `hook: false, component: false` → the toast container was not found in this
  build; the plugin did nothing. Please open an issue with your Discord version.
- `filled a missing toast position` → layer 1 caught the root cause.
- `dropped toast (missing-id)` / `(not-an-object)` → layer 2 caught a malformed
  entry that would have crashed the container.
- `toast container crashed, using safe state` → the hook still threw; the crash
  was contained. Include the logged error in a report.

## Tests

```bash
bun run check     # typecheck + build + tests
```

Three layers, all runnable without Discord:

- `test/toastGuard.test.ts` (31 tests) covers the pure logic with Node's built-in
  runner: entry sanitising, position inference, handler repair, state
  normalisation, payload completion, crash containment.
- `test/plugin.test.ts` (9 tests) loads the real Revenge Next bundle against
  stubbed runtime modules, so it also validates the `plugin()` definition, module
  discovery by props, the `instead`/`before` hook contract, the settings
  switches, and unpatching on stop.
- `test/legacy.test.ts` (4 tests) replays `evalPlugin` from Revenge legacy
  (`vendetta => { return <bundle> }`) against a stubbed Vendetta API: the plugin
  object shape, the guarded hook, dispatcher payload completion, unpatching on
  `onUnload`, and the settings switches.
- `test/package.test.ts` (5 tests) checks the published artifacts: `index.json`
  against the zip's real `sha256`/size, the zip contents, the legacy manifest
  against `dist/legacy.js`, and that the legacy bundle is one expression (a
  leading comment would make the loader's `return` hit ASI and hand back
  `undefined`).

```bash
node --test test/toastGuard.test.ts test/plugin.test.ts test/legacy.test.ts test/package.test.ts
```

## Project layout

```
plugin.json         Revenge Next metadata (id, version, dependencies) — source of truth
manifest.json       Revenge legacy manifest (generated, committed)
index.json          Revenge Next repository index (generated, committed)
pool/               one zip per published version (generated, committed)
dist/index.js       Revenge Next bundle (generated, committed)
dist/legacy.js      Revenge legacy bundle (generated, committed)
src/toastGuard.ts   pure logic (tested)
src/config.ts       settings shape + defaults
src/index.ts        Next: plugin definition, module discovery, patches
src/settings.tsx    Next: settings UI
src/legacy/index.ts legacy: the same layers on the Vendetta API
src/legacy/settings.ts  legacy: settings UI built from `Forms`
src/legacy/types.ts     the slice of the Vendetta API the plugin uses
scripts/build-legacy.mjs   wraps the legacy CJS build into one expression
scripts/build-package.mjs  writes manifest.json, dist/manifest.json, zip, index.json
test/                      see [Tests](#tests)
types/              local Revenge Next runtime declarations (offline typecheck)
```

## Known limitations

- **Discovery is best-effort.** It was written without access to a matching
  `index.android.bundle`, so the dispatcher keys are a superset of the plausible
  names. If the hook is found (the common case) the crash is prevented
  regardless; if only the dispatchers are found, the root cause is fixed but a
  malformed entry from another code path can still reach the container.
- **`position` inheritance is heuristic.** Discord accepts several position
  strings; reusing a sibling's value is safer than inventing one.
- `types/revenge-local.d.ts` is a local shim so `tsc` works offline. Install
  `@revenge-mod/types` and delete it to typecheck against the real runtime API.
