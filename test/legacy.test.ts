import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Integration test for the Revenge legacy (Vendetta) bundle.
 *
 * It replays what `evalPlugin` does in `revenge-bundle`:
 *
 *   (0, eval)(`vendetta=>{return ${js}}`)(vendettaForPlugins)
 *
 * and then calls the returned function, which has to yield
 * `{ onLoad, onUnload, settings }`. This is the contract that "Failed to fetch
 * manifest" / "Failed to fetch JS" hide, so it is worth pinning down.
 *
 * Requires `bun run build` first (`bun run check` does that).
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(root, 'dist/legacy.js'), 'utf8')
const load = new Function('vendetta', `return ${source}`) as (api: unknown) => any

type AnyRecord = Record<string, any>
type AnyFunction = (...args: any[]) => any

function createRuntime() {
	const delivered: AnyRecord[] = []
	const storage: AnyRecord = {}

	const toastModule: AnyRecord = {
		useToastContainer: () => ({
			toasts: [null, { id: 'a', position: 'bottom' }, { id: 'b' }],
			handlers: {},
		}),
	}

	const dispatcher: AnyRecord = {
		showToast(payload: AnyRecord) {
			delivered.push(payload)
			return payload
		},
	}

	const modules = [toastModule, dispatcher]

	/** Mirrors spitroast: `instead(key, parent, (args, original))`. */
	const patcher = {
		instead(key: string, parent: AnyRecord, handler: AnyFunction) {
			const original = parent[key]
			parent[key] = function (this: unknown, ...args: unknown[]) {
				return handler.call(this, args, original)
			}
			return () => {
				parent[key] = original
				return true
			}
		},
		before(key: string, parent: AnyRecord, handler: AnyFunction) {
			const original = parent[key]
			parent[key] = function (this: unknown, ...args: unknown[]) {
				const next = handler.call(this, args)
				return original.apply(this, next ?? args)
			}
			return () => {
				parent[key] = original
				return true
			}
		},
	}

	const api = {
		metro: {
			common: { React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) } },
			findByProps: (key: string) => modules.find(module => key in module),
			findByPropsAll: (key: string) => modules.filter(module => key in module),
		},
		patcher,
		storage: { useProxy: (target: unknown) => target },
		ui: {
			components: {
				Forms: { FormSection: 'FormSection', FormRow: 'FormRow', FormSwitch: 'FormSwitch' },
			},
		},
		logger: { log() {}, warn() {}, error() {} },
		plugin: { id: 'https://example.test/plugin/', manifest: {}, storage },
	}

	return { api, toastModule, dispatcher, delivered, storage }
}

function start() {
	const runtime = createRuntime()
	const factory = load(runtime.api)
	assert.equal(typeof factory, 'function', 'the bundle must evaluate to a factory')

	const plugin = factory()
	assert.deepEqual(Object.keys(plugin).sort(), ['onLoad', 'onUnload', 'settings'])

	plugin.onLoad()
	return { ...runtime, plugin }
}

test('the container hook never hands a malformed toast to the renderer', () => {
	const { toastModule } = start()
	const state = toastModule.useToastContainer()

	assert.equal(state.toasts.length, 2)
	assert.deepEqual(
		state.toasts.map((toast: AnyRecord) => toast.id),
		['a', 'b'],
	)
	// A missing position inherits its sibling's
	assert.equal(state.toasts[1].position, 'bottom')
})

test('a toast without a position gets one before Discord enqueues it', () => {
	const { dispatcher, delivered } = start()
	dispatcher.showToast({ content: 'hello' })

	assert.equal(delivered.length, 1)
	assert.equal(delivered[0].position, 'bottom')
})

test('onUnload restores the original modules', () => {
	const { toastModule, dispatcher, delivered, plugin } = start()
	plugin.onUnload()

	assert.equal(toastModule.useToastContainer().toasts.length, 3)

	const payload: AnyRecord = { content: 'hello' }
	dispatcher.showToast(payload)
	assert.equal('position' in payload, false)
	assert.equal(delivered.length, 1)
})

test('the settings component toggles the stored settings', () => {
	const { storage, plugin, toastModule } = start()
	const element = (plugin.settings as AnyFunction)()

	assert.equal(element.type, 'FormSection')
	const rows = element.children as AnyRecord[]
	assert.deepEqual(
		rows.map(row => row.props.label),
		['Guard the toast container', 'Fix toasts at the source', 'Log dropped toasts'],
	)

	// Turning the guard off leaves Discord's own state alone
	rows[0].props.trailing.props.onValueChange(false)
	assert.equal(storage.sanitizeContainer, false)
	assert.equal(toastModule.useToastContainer().toasts.length, 3)
})
