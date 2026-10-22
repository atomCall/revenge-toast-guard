import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Packages the plugin for both plugin systems that call themselves Revenge.
 *
 * Revenge Next consumes a repository: an `index.json` (format 1) listing every
 * version, plus one zip per version holding `manifest.json` and the built script.
 *
 *   index.json                          repository index, absolute artifact URLs
 *   pool/<id>@<version>.zip             manifest.json + index.js
 *   dist/manifest.json                  same metadata, script relative to dist/
 *
 * Revenge legacy (Vendetta, and the Bunny/Pyon forks) instead fetches
 * `<repo>/manifest.json` and then `<repo>/<main>`, so the repository root carries
 * a polymanifest pointing at the legacy bundle:
 *
 *   manifest.json                       name/description/authors/main/hash
 *   dist/legacy.js                      `vendetta => { return <plugin> }` bundle
 *
 * `plugin.json` is the single source of truth for the Next metadata; the legacy
 * manifest is derived from it plus the hash of the built legacy bundle.
 *
 * The artifact URL defaults to this repository's raw GitHub URL; override it
 * with ARTIFACT_BASE_URL when serving the pool from somewhere else (Pages, a CDN).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const writeJSON = (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, '\t')}\n`)

const next = readJSON('plugin.json')
const pkg = readJSON('package.json')
const { id, version } = next

const rawBase = (() => {
	const url = pkg.repository?.url ?? ''
	const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/)
	if (!match) throw new Error('package.json "repository.url" must point at a GitHub repository')
	return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main`
})()

const artifactBase = (process.env.ARTIFACT_BASE_URL ?? `${rawBase}/pool`).replace(/\/$/, '')

const script = join(root, 'dist/index.js')
const legacyScript = join(root, 'dist/legacy.js')
if (!existsSync(script)) throw new Error('dist/index.js is missing: run `bun build` first')
if (!existsSync(legacyScript)) throw new Error('dist/legacy.js is missing: run `node scripts/build-legacy.mjs` first')

writeJSON('dist/manifest.json', {
	...next,
	dist: { ...next.dist, script: basename(next.dist.script) },
})

// Revenge legacy reads the manifest straight off the repository root, then
// resolves `main` relative to it. `hash` only has to change with the bundle.
writeJSON('manifest.json', {
	name: next.name,
	description: next.description,
	authors: [{ name: next.author }],
	main: 'dist/legacy.js',
	hash: createHash('sha256').update(readFileSync(legacyScript)).digest('hex'),
	vendetta: { icon: 'ShieldIcon' },
})

const stage = mkdtempSync(join(tmpdir(), 'toast-guard-pkg-'))
copyFileSync(join(root, 'dist/manifest.json'), join(stage, 'manifest.json'))
copyFileSync(script, join(stage, 'index.js'))

// Fixed timestamps keep the zip (and therefore its sha256) reproducible.
const EPOCH = new Date('1980-02-01T00:00:00Z')
for (const file of ['manifest.json', 'index.js']) utimesSync(join(stage, file), EPOCH, EPOCH)

mkdirSync(join(root, 'pool'), { recursive: true })
const zipName = `${id}@${version}.zip`
const zipPath = join(root, 'pool', zipName)

rmSync(zipPath, { force: true })
execFileSync('zip', ['-q', '-X', '-j', zipPath, join(stage, 'manifest.json'), join(stage, 'index.js')], {
	env: { ...process.env, TZ: 'UTC' },
})
rmSync(stage, { recursive: true, force: true })

const artifact = {
	url: `${artifactBase}/${zipName}`,
	sha256: createHash('sha256').update(readFileSync(zipPath)).digest('hex'),
	size: statSync(zipPath).size,
	...(next.dependencies ? { dependencies: next.dependencies } : {}),
}

writeJSON('index.json', {
	format: 1,
	name: next.name,
	description: next.description,
	plugins: {
		[id]: {
			name: next.name,
			description: next.description,
			author: next.author,
			channels: { latest: version },
			versions: { [version]: artifact },
		},
	},
})

console.log(`manifest.json -> Revenge legacy, main: dist/legacy.js`)
console.log(`dist/manifest.json -> Revenge Next, script: ${basename(next.dist.script)}`)
console.log(`pool/${zipName} -> ${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 12)}...`)
console.log(`index.json -> ${id}@${version}`)

