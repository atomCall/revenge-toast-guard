import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the Revenge legacy (Vendetta) bundle.
 *
 * The legacy loader evaluates a plugin as `vendetta => { return <plugin.js> }`
 * (see `evalPlugin` in `revenge-bundle/src/core/vendetta/plugins.ts`), so the
 * published file must be a single expression. Bun only emits statements, so the
 * CJS output is wrapped in an IIFE that returns the plugin object.
 *
 * Nothing may be required at runtime: `react` and friends are taken from the
 * host through `vendetta`, never imported.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = mkdtempSync(join(tmpdir(), 'toast-guard-legacy-'))
const cjs = join(stage, 'legacy.cjs')

try {
	execFileSync(
		'bun',
		[
			'build',
			join(root, 'src/legacy/index.ts'),
			`--outfile=${cjs}`,
			'--target=browser',
			'--format=cjs',
		],
		{ stdio: 'inherit' },
	)

	const body = readFileSync(cjs, 'utf8')
	if (/\brequire\s*\(/.test(body)) {
		throw new Error('the legacy bundle must not require() anything at runtime')
	}

	const bundle = [
		// No leading comment: the loader does `vendetta=>{return <bundle>}`, and
		// `return // comment` would hit ASI and return undefined.
		'(() => {',
		'\t// Revenge legacy plugin bundle — evaluated as `vendetta => { return <this file> }`.',
		'\tconst module = { exports: {} };',
		'\tconst exports = module.exports;',
		body.trimEnd(),
		'\treturn module.exports.default ?? module.exports;',
		'})()',
		'',
	].join('\n')


	writeFileSync(join(root, 'dist/legacy.js'), bundle)
	console.log(`dist/legacy.js -> ${Buffer.byteLength(bundle)} bytes`)
} finally {
	rmSync(stage, { recursive: true, force: true })
}
