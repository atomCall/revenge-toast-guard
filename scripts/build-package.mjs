import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Packages the plugin the way Revenge Next consumes it.
 *
 * A repository is an `index.json` (format 1) listing every plugin version, plus
 * one zip per version holding `manifest.json` and the built script side by side:
 *
 *   index.json                          repository index, absolute artifact URLs
 *   pool/<id>@<version>.zip             manifest.json + index.js
 *   dist/manifest.json                  same metadata, script relative to dist/
 *
 * The artifact URL defaults to this repository's raw GitHub URL; override it
 * with ARTIFACT_BASE_URL when serving the pool from somewhere else (Pages, a CDN).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const writeJSON = (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, '\t')}\n`)

const manifest = readJSON('manifest.json')
const pkg = readJSON('package.json')
const { id, version } = manifest

const rawBase = (() => {
	const url = pkg.repository?.url ?? ''
	const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/)
	if (!match) throw new Error('package.json "repository.url" must point at a GitHub repository')
	return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main`
})()

const artifactBase = (process.env.ARTIFACT_BASE_URL ?? `${rawBase}/pool`).replace(/\/$/, '')

const script = join(root, 'dist/index.js')
if (!existsSync(script)) throw new Error('dist/index.js is missing: run `bun build` first')

writeJSON('dist/manifest.json', {
	...manifest,
	dist: { ...manifest.dist, script: basename(manifest.dist.script) },
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
	...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
}

writeJSON('index.json', {
	format: 1,
	name: manifest.name,
	description: manifest.description,
	plugins: {
		[id]: {
			name: manifest.name,
			description: manifest.description,
			author: manifest.author,
			channels: { latest: version },
			versions: { [version]: artifact },
		},
	},
})

console.log(`dist/manifest.json -> script: ${basename(manifest.dist.script)}`)
console.log(`pool/${zipName} -> ${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 12)}...`)
console.log(`index.json -> ${id}@${version}`)
