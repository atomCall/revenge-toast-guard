# Toast Guard

A [Revenge](https://revenge-mod.dev) (Revenge **Next**) plugin that stops the
Discord Android crash:

```
TypeError: Cannot read property 'position' of undefined
  at useToastContainer (index.android.bundle)
```

## Install

This repository is a Revenge **plugin repository**: Revenge fetches `index.json`
(format 1), picks the newest version, downloads the zip it points at, and
verifies its `sha256` before installing it.

Add this URL as a plugin repository in Revenge:

```
https://raw.githubusercontent.com/atomCall/revenge-toast-guard/main
```

Then enable **Toast Guard** in the plugin list. Its settings page toggles each
layer individually; the defaults protect everything.

Manual install (if your build has no repository support): unzip
`pool/attard.toast-guard@1.0.0.zip` into
`/sdcard/Revenge/plugins/attard.toast-guard/` and restart Discord.

What gets published:

```
index.json                     repository index (format 1), absolute artifact URL + sha256
pool/<id>@<version>.zip        manifest.json + index.js side by side
manifest.json                  source metadata (dist.script = dist/index.js)
dist/index.js                  built script
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

`bun run build` writes `dist/index.js` and the publishable artifacts described
in [Install](#install):

```
dist/index.js
dist/manifest.json
pool/<id>@<version>.zip
index.json
```

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

Two layers, both runnable without Discord:

- `test/toastGuard.test.ts` (31 tests) covers the pure logic with Node's built-in
  runner: entry sanitising, position inference, handler repair, state
  normalisation, payload completion, crash containment.
- `test/plugin.test.ts` (9 tests) builds the plugin and loads the real bundle
  against stubbed Revenge runtime modules, so it also validates the `plugin()`
  definition, module discovery by props, the `instead`/`before` hook contract,
  the settings switches, and unpatching on stop.

```bash
node --test test/toastGuard.test.ts test/plugin.test.ts
```

## Project layout

```
index.json          repository index consumed by Revenge (generated)
pool/               one zip per published version (generated, committed)
src/toastGuard.ts   pure logic (tested)
src/index.ts        plugin definition, module discovery, patches
src/settings.tsx    settings UI
src/config.ts       settings shape + defaults
scripts/            build helpers (packaging + index.json generation)
test/toastGuard.test.ts  pure logic suite
test/plugin.test.ts      bundle-level integration suite
types/              local Revenge runtime declarations (offline typecheck)
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
