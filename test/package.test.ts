import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Guards the published artifacts.
 *
 * Revenge Next verifies `sha256` and `size` from `index.json` against the zip it
 * downloads, so a stale pool entry after a version bump would install nothing but
 * a checksum error. Revenge legacy fetches `manifest.json` from the repository
 * root and then resolves `main` relative to it, so both files have to agree with
 * what the build actually produced.
 *
 * Requires `bun run build` first (`bun run check` does that).
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const readJSON = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

const plugin = readJSON('plugin.json')
const index = readJSON('index.json')
const artifact = `${plugin.id}@${plugin.version}.zip`
const zipPath = join(root, 'pool', artifact)
const entry = index.plugins?.[plugin.id]?.versions?.[plugin.version]

test('index.json describes this plugin', () => {
	assert.equal(index.format, 1)
	assert.ok(entry, `index.json has no ${plugin.id}@${plugin.version} entry`)
	assert.equal(index.plugins[plugin.id].name, plugin.name)
	assert.equal(index.plugins[plugin.id].channels.latest, plugin.version)
	assert.equal(entry.dependencies['revenge.api'].version, '>=1 <2')
	assert.equal(entry.dependencies.discord.version, '*')
})

test('index.json points at the committed artifact with a matching hash', () => {
	const bytes = readFileSync(zipPath)
	// Built from the version rather than written out, so a bump cannot fail here.
	assert.match(entry.url, /^https:\/\/\S+$/)
	assert.ok(entry.url.endsWith(`/pool/${artifact}`), `unexpected artifact url: ${entry.url}`)
	assert.equal(entry.size, statSync(zipPath).size)
	assert.equal(entry.size, bytes.length)
	assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('the artifact holds the manifest and script the build produces', () => {
	const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n')
	assert.deepEqual(names, ['manifest.json', 'index.js'])

	const packed = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }))
	assert.deepEqual(packed, readJSON('dist/manifest.json'))
	assert.equal(packed.dist.script, 'index.js')

	const script = execFileSync('unzip', ['-p', zipPath, 'index.js'], { encoding: 'utf8' })
	assert.equal(script, readFileSync(join(root, 'dist/index.js'), 'utf8'))
})

test('manifest.json is the Vendetta manifest for the committed legacy bundle', () => {
	const legacy = readJSON('manifest.json')
	assert.equal(legacy.name, plugin.name)
	assert.equal(legacy.description, plugin.description)
	assert.equal(legacy.authors[0].name, plugin.author)

	// Revenge legacy resolves `main` relative to the repository root
	assert.equal(legacy.main, 'dist/legacy.js')
	const bytes = readFileSync(join(root, legacy.main))
	assert.equal(legacy.hash, createHash('sha256').update(bytes).digest('hex'))
})

test('the legacy bundle is a single expression, as the loader requires', () => {
	const source = readFileSync(join(root, 'dist/legacy.js'), 'utf8').trim()

	// The loader does `vendetta => { return <bundle> }`; a leading comment would
	// let ASI terminate the return statement and hand back undefined.
	assert.ok(source.startsWith('('), 'the bundle must start with an expression, not a comment')
	assert.ok(source.endsWith('()'), 'the bundle must be a self-invoking expression')
	assert.ok(!/^\s*(import|export)\s/m.test(source), 'the bundle must not contain module syntax')
})

