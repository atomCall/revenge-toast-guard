import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Integration test: loads the built bundle against stubbed Revenge runtime
 * modules. This validates what unit tests cannot reach: the `plugin()`
 * definition, module discovery, and the exact `instead`/`before` hook contract.
 *
 * Requires `bun run build` first (`bun run check` does that).
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(root, 'dist/index.js')

const stubs: Record<string, string> = {
	'@revenge-mod/modules/package.json': JSON.stringify({
		name: '@revenge-mod/modules',
		exports: {
			'./finders': './finders/index.js',
			'./finders/filters': './finders/filters/index.js',
		},
	}),
	'@revenge-mod/patcher/package.json': JSON.stringify({
		name: '@revenge-mod/patcher',
		exports: './index.js',
	}),
	'@revenge-mod/discord/package.json': JSON.stringify({
		name: '@revenge-mod/discord',
		exports: { './design': './design/index.js' },
	}),
	'@revenge-mod/components/package.json': JSON.stringify({
		name: '@revenge-mod/components',
		exports: {
			'./Page': './Page/index.js',
			'./TableRowAssetIcon': './TableRowAssetIcon/index.js',
		},
	}),
	'react/package.json': JSON.stringify({
		name: 'react',
		exports: { './jsx-runtime': './jsx-runtime.js' },
	}),
	'@revenge-mod/modules/finders/index.js': `
export function getModules(filter, callback) {
	for (const module of globalThis.__toastGuardRegistry) {
		if (!filter || filter.test(module)) callback(module)
	}
	return () => {}
}
`,
	'@revenge-mod/modules/finders/filters/index.js': `
export const withProps = (...props) => ({ test: module => props.every(prop => prop in module) })
`,
	'@revenge-mod/patcher/index.js': `
export function instead(parent, key, hook) {
	const original = parent[key]
	parent[key] = function (...args) {
		return hook.call(this, args, original)
	}
	return () => { parent[key] = original }
}

export function before(parent, key, hook) {
	const original = parent[key]
	parent[key] = function (...args) {
		const next = hook.call(this, args)
		return original.apply(this, Array.isArray(next) ? next : args)
	}
	return () => { parent[key] = original }
}
`,
	'react/jsx-runtime.js': `
export const Fragment = Symbol('Fragment')
export const jsx = (type, props) => ({ type, props })
export const jsxs = jsx
`,
	'@revenge-mod/discord/design/index.js': `
export const Design = { TableRowGroup: 'TableRowGroup', TableSwitchRow: 'TableSwitchRow' }
`,
	'@revenge-mod/components/Page/index.js': `export default 'Page'`,
	'@revenge-mod/components/TableRowAssetIcon/index.js': `export default 'TableRowAssetIcon'`,
}

const write = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
}

async function startPlugin(registry: any[], settings: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'toast-guard-'))

	for (const [name, source] of Object.entries(stubs)) write(join(dir, 'node_modules', name), source)
	write(join(dir, 'package.json'), '{"type":"module"}')
	cpSync(bundle, join(dir, 'index.js'))

	;(globalThis as any).__toastGuardRegistry = registry
	;(globalThis as any).plugin = (options: unknown) => options

	const { default: definition } = await import(pathToFileURL(join(dir, 'index.js')).href)
	rmSync(dir, { recursive: true, force: true })

	const unpatch: Array<() => void> = []
	definition.start({
		cleanup: (...fns: Array<() => void>) => unpatch.push(...fns),
		jsonStorage: { cache: settings, use: () => settings, set: () => {} },
		plugin: { requireReload: () => {}, reportError: () => {} },
	})

	return { definition, unpatch }
}

const handlers = () => ({
	updateHeight: () => {},
	startPause: () => {},
	endPause: () => {},
	calculateOffset: () => 0,
})

test('the bundle exports a plugin definition with a settings component', async () => {
	const { definition } = await startPlugin([])

	assert.equal(typeof definition.start, 'function')
	assert.equal(typeof definition.SettingsComponent, 'function')
	assert.equal(typeof definition.stop, 'function')
})

test('a healthy toast container is returned untouched', async () => {
	const healthy = { toasts: [{ id: 'a', position: 'top' }], handlers: handlers() }
	const module = { useToastContainer: () => healthy }
	await startPlugin([module])

	const state = module.useToastContainer()

	assert.equal(state, healthy)
	assert.equal(state.toasts[0].position, 'top')
	assert.equal(state.handlers.calculateOffset(), 0)
})

test('a malformed entry is replaced without changing the list length', async () => {
	const module = {
		useToastContainer: () => {
			const toasts: any[] = [{ id: 'a', position: 'top' }]
			// Reading a hole is what crashes Discord's container
			return { toasts: [toasts[1], { id: 'b', position: 'top' }], handlers: handlers() }
		},
	}
	await startPlugin([module])

	assert.doesNotThrow(() => module.useToastContainer())

	const state = module.useToastContainer()
	assert.equal(state.toasts.length, 2)
	assert.equal(typeof state.toasts[0].id, 'string')
	assert.equal(state.toasts[1].id, 'b')
})

test('an entry without a position inherits the sibling position', async () => {
	const module = {
		useToastContainer: () => ({
			toasts: [{ id: 'a' }, { id: 'b', position: 'bottom' }],
			handlers: handlers(),
		}),
	}
	await startPlugin([module])

	assert.equal(module.useToastContainer().toasts[0].position, 'bottom')
})

test('a toast payload is completed before it is enqueued', async () => {
	const module = { showToast: (payload: any) => payload }
	await startPlugin([module])

	assert.equal(module.showToast({ content: 'hi' }).position, 'bottom')
	assert.equal(module.showToast({ content: 'hi', position: 'top' }).position, 'top')
})

test('turning the container guard off leaves the hook alone', async () => {
	const module = {
		useToastContainer: () => {
			throw new TypeError("Cannot read property 'position' of undefined")
		},
	}
	await startPlugin([module], { sanitizeContainer: false })

	assert.throws(() => module.useToastContainer(), TypeError)
})

test('turning the dispatcher guard off leaves the payload alone', async () => {
	const module = { showToast: (payload: any) => payload }
	await startPlugin([module], { sanitizeDispatcher: false })

	assert.equal('position' in module.showToast({ content: 'hi' }), false)
})

test('a throwing hook is not swallowed by the guard', async () => {
	const module = {
		useToastContainer: () => {
			throw new TypeError("Cannot read property 'position' of undefined")
		},
	}
	await startPlugin([module])

	// Swallowing it would desync React's hook list and crash the next render
	assert.throws(() => module.useToastContainer(), TypeError)
})

test('stopping the plugin unpatches everything', async () => {
	const original = () => ({ toasts: [{ id: 'a', position: 'top' }], handlers: handlers() })
	const module = { useToastContainer: original }
	const { unpatch } = await startPlugin([module])

	assert.notEqual(module.useToastContainer, original)

	for (const fn of unpatch) fn()
	assert.equal(module.useToastContainer, original)
})
