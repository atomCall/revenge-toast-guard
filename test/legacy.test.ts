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

function createRuntime(options: { component?: AnyFunction } = {}) {
	const delivered: AnyRecord[] = []
	const storage: AnyRecord = {}

	const toastState: AnyRecord = {
		toasts: [null, { id: 'a', position: 'bottom' }, { id: 'b' }],
		handlers: {},
	}

	let current = toastState

	const toastModule: AnyRecord = {
		useToastContainer: () => current,
		// This build's own default; the plugin must prefer it over its fallback
		DEFAULT_TOAST_POSITION: 'top',
	}
	if (options.component) toastModule.default = options.component

	// `useToastStore` is a zustand-style hook that is also used as the store
	// object itself (`useToastStore.getState()`), so the patch has to keep the
	// statics reachable.
	let storeState: AnyRecord = { key: 'app', toast: { text: 'hi', position: 'top' } }
	const storeModule: AnyRecord = {
		useToastStore: Object.assign((selector: AnyFunction) => selector(storeState), {
			getState: () => storeState,
		}),
	}

	const dispatcher: AnyRecord = {
		showToast(payload: AnyRecord) {
			delivered.push(payload)
			return payload
		},
	}

	const modules = [toastModule, storeModule, dispatcher]

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

	return {
		api,
		toastModule,
		toastState,
		storeModule,
		dispatcher,
		delivered,
		storage,
		setToastState(next: AnyRecord) {
			current = next
		},
		setStoreState(next: AnyRecord) {
			storeState = next
		},
	}
}

function start(options: { component?: AnyFunction } = {}) {
	const runtime = createRuntime(options)
	const factory = load(runtime.api)
	assert.equal(typeof factory, 'function', 'the bundle must evaluate to a factory')

	const plugin = factory()
	assert.deepEqual(Object.keys(plugin).sort(), ['onLoad', 'onUnload', 'settings'])

	plugin.onLoad()
	return { ...runtime, plugin }
}

/** Collects what the plugin writes to the React Native log. */
function captureWarnings(run: () => void): string[] {
	const lines: string[] = []
	const original = console.warn
	console.warn = (...args: unknown[]) => {
		lines.push(args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
	}
	try {
		run()
	} finally {
		console.warn = original
	}
	return lines
}

test('the container hook never hands a malformed toast to the renderer', () => {
	const { toastModule, toastState } = start()
	const state = toastModule.useToastContainer()

	// Same length and order as Discord's list: changing either makes the
	// container render a different number of hooks and React then throws
	// `Cannot read property 'length' of undefined` in areHookInputsEqual.
	assert.equal(state.toasts.length, toastState.toasts.length)
	assert.equal(typeof state.toasts[0].id, 'string')
	assert.equal(state.toasts[1].id, 'a')
	assert.equal(state.toasts[2].id, 'b')
	// A missing position inherits its sibling's
	assert.equal(state.toasts[2].position, 'bottom')
	// Discord's own state is left untouched
	assert.equal(toastState.toasts[0], null)
})

test('a healthy container keeps its state identity across renders', () => {
	const { toastModule, setToastState } = start()

	const handlers = {
		updateHeight: () => undefined,
		startPause: () => undefined,
		endPause: () => undefined,
		calculateOffset: () => 0,
	}
	const healthy = { toasts: [{ id: 'a', position: 'top' }], handlers }
	setToastState(healthy)

	// Nothing to repair: the same object comes back, so consumers that compare
	// by identity do not re-render.
	assert.equal(toastModule.useToastContainer(), healthy)
})

test('a toast without a position gets one before Discord enqueues it', () => {
	const { dispatcher, delivered } = start()
	dispatcher.showToast({ content: 'hello' })

	assert.equal(delivered.length, 1)
	// The container's own default wins over the plugin's fallback
	assert.equal(delivered[0].position, 'top')
})

test('a dispatcher call with no toast payload never reaches Discord', () => {
	const { dispatcher, delivered } = start()

	dispatcher.showToast(undefined)
	dispatcher.showToast()

	// Forwarding it would store `{toast: undefined}` and crash the container
	assert.equal(delivered.length, 0)
})

test('a store entry without a toast is reported as no toast', () => {
	const { storeModule, setStoreState } = start()

	// The container selects the whole `{toast, key}` entry, not the toast
	setStoreState({ key: 'app', toast: undefined })
	assert.equal(storeModule.useToastStore((state: AnyRecord) => state), null)

	const healthy = { key: 'app', toast: { text: 'hi', position: 'top' } }
	setStoreState(healthy)
	assert.equal(storeModule.useToastStore((state: AnyRecord) => state), healthy)
})

test('the patched toast store keeps its own helpers reachable', () => {
	const { storeModule } = start()

	// Discord calls `useToastStore.getState()` directly, so the patch cannot
	// simply replace the function object with a bare wrapper
	assert.equal(typeof storeModule.useToastStore.getState, 'function')
	assert.equal(storeModule.useToastStore.getState().key, 'app')
})

test('a sliced selector is left alone', () => {
	const { storeModule } = start()

	// Only entries shaped like `{toast, key}` are store entries; selectors that
	// return a map or a boolean must not be rewritten to null
	const map = new Map()
	assert.equal(storeModule.useToastStore(() => map), map)
	assert.equal(storeModule.useToastStore(() => true), true)
	assert.equal(storeModule.useToastStore(() => 0), 0)
})

test('onUnload restores the original modules', () => {
	const { toastModule, toastState, storeModule, dispatcher, delivered, plugin } = start()
	const useToastStore = storeModule.useToastStore
	plugin.onUnload()

	const state = toastModule.useToastContainer()
	assert.equal(state, toastState)
	assert.equal(state.toasts.length, 3)
	assert.equal('position' in state.toasts[2], false)

	// The store is handed back untouched too
	assert.notEqual(storeModule.useToastStore, useToastStore)
	const entry = { key: 'app', toast: undefined }
	assert.equal(storeModule.useToastStore(() => entry), entry)
	assert.equal(typeof storeModule.useToastStore.getState, 'function')

	const payload: AnyRecord = { content: 'hello' }
	dispatcher.showToast(payload)
	assert.equal('position' in payload, false)
	assert.equal(delivered.length, 1)
})

test('the settings component toggles the stored settings', () => {
	const { storage, plugin, toastModule, toastState } = start()
	const element = (plugin.settings as AnyFunction)()

	assert.equal(element.type, 'FormSection')
	const rows = element.children as AnyRecord[]
	assert.deepEqual(
		rows.map(row => row.props.label),
		['Guard the toast container', 'Fix toasts at the source', 'Log repaired toasts'],
	)

	// Turning the guard off leaves Discord's own state alone
	rows[0].props.trailing.props.onValueChange(false)
	assert.equal(storage.sanitizeContainer, false)
	assert.equal(toastModule.useToastContainer(), toastState)
})

test('the guard reports the shape of the state Discord handed over', () => {
	const lines = captureWarnings(() => {
		const { toastModule } = start()
		// Repeated renders of the same shape must not repeat the line
		toastModule.useToastContainer()
		toastModule.useToastContainer()
	})

	const shapes = lines.filter(line => line.startsWith('[ToastGuard] hook result'))
	assert.equal(shapes.length, 1)
	assert.equal(
		shapes[0],
		'[ToastGuard] hook result #1 (render 1): ' +
			'{toasts:array(3)[null,{id:"a",position:"bottom"},{id:"b"}],handlers:{}}',
	)
	assert.ok(
		lines.some(line => line.startsWith('[ToastGuard] hook module exports: ')),
		'the exports of the module that owns the hook name the rest of the subsystem',
	)
})

test('a crashing container logs the state it crashed on and still throws', () => {
	const crashing = function ToastContainer(): unknown {
		throw new TypeError("Cannot read property 'position' of undefined")
	}

	let instrumented = false
	const lines = captureWarnings(() => {
		const { toastModule } = start({ component: crashing })
		instrumented = toastModule.default !== crashing
		toastModule.useToastContainer()

		assert.throws(() => toastModule.default({}), /position/)
		// The container's own error must not be replaced by the diagnostic one
		assert.throws(() => toastModule.default({}), TypeError)
	})

	assert.ok(instrumented, 'the component shipped next to the hook is instrumented')
	const crash = lines.find(line => line.includes('ToastContainer threw on render'))
	assert.ok(crash, 'the crash is logged')
	assert.match(crash, /last hook result: \{toasts:array\(3\)/)
})

