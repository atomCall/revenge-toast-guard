import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Guards the published artifacts. Revenge verifies `sha256` and `size` from
 * `index.json` against the zip it downloads, so a stale pool entry after a
 * version bump would install nothing but a checksum error.
 *
 * Requires `bun run build` first (`bun run check` does that).
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const readJSON = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

const manifest = readJSON('manifest.json')
const index = readJSON('index.json')
const artifact = `${manifest.id}@${manifest.version}.zip`
const zipPath = join(root, 'pool', artifact)
const entry = index.plugins?.[manifest.id]?.versions?.[manifest.version]

test('index.json describes this plugin', () => {
	assert.equal(index.format, 1)
	assert.ok(entry, `index.json has no ${manifest.id}@${manifest.version} entry`)
	assert.equal(index.plugins[manifest.id].name, manifest.name)
	assert.equal(index.plugins[manifest.id].channels.latest, manifest.version)
	assert.equal(entry.dependencies['revenge.api'].version, '>=1 <2')
	assert.equal(entry.dependencies.discord.version, '*')
})

test('index.json points at the committed artifact with a matching hash', () => {
	const bytes = readFileSync(zipPath)
	assert.match(entry.url, /^https:\/\/\S+\/pool\/attard\.toast-guard@1\.0\.0\.zip$/)
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
