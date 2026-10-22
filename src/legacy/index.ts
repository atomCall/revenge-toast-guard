import { DEFAULT_SETTINGS, type Settings } from '../config'
import { createInspector, describeModule, describeValue, findComponentExports } from '../diagnostics'
import {
	DEFAULT_POSITION,
	ensurePosition,
	guardToastState,
	repairToastEntry,
	type ToastPosition,
} from '../toastGuard'
import createSettings from './settings'
import type { AnyFunction, LegacyApi, LegacyModule, LegacyPlugin } from './types'

/**
 * Revenge legacy (Vendetta) entry point.
 *
 * The loader wraps this bundle as `vendetta => { return <bundle> }`, calls the
 * returned function, and reads `{ onLoad, onUnload, settings }` off the result —
 * see `fetchPlugin`/`evalPlugin` in `revenge-bundle/src/core/vendetta/plugins.ts`.
 *
 * There is no reactive module finder here, so discovery is a bounded retry loop
 * instead of a subscription.
 */

declare const vendetta: LegacyApi

const MAX_DIAGNOSTICS = 20
const MAX_INSPECTION = 12
const RETRY_INTERVAL = 1_000
const MAX_SCANS = 15

const COMPONENT_NAME = 'ToastContainer'

const HOOK_KEYS = ['useToastContainer'] as const
const STORE_KEYS = ['useToastStore'] as const
const DISPATCH_KEYS = ['showToast', 'addToast', 'pushToast', 'enqueueToast', 'createToast'] as const

export default function ToastGuard(): LegacyPlugin {
	// The loader passes a per-plugin copy of the API (it carries `plugin.storage`)
	const api: LegacyApi =
		typeof vendetta === 'undefined' ? (globalThis as any).vendetta : vendetta
	const storage = (api.plugin?.storage ?? {}) as Partial<Settings>

	// A cache written by an older version may miss keys; merge over defaults
	const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...storage })

	let diagnostics = 0
	let inspected = 0
	let renders = 0
	let dispatchersPatched = 0
	let hookPatched = false
	let storePatched = false
	let reportedEmptyToast = false
	let scans = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let finished = false

	/** The container's own default, used to complete payloads. */
	let toastDefaultPosition: ToastPosition | undefined

	const unpatch: (() => unknown)[] = []
	const patchedDispatchers = new WeakMap<LegacyModule, Set<string>>()
	const patchedStores = new WeakSet<LegacyModule>()

	const defaultPosition = (): ToastPosition => toastDefaultPosition ?? DEFAULT_POSITION

	function diagnose(label: string, detail: unknown): void {
		if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS) return
		diagnostics++
		console.warn(`[ToastGuard] ${label}`, detail)
	}

	/**
	 * Shape reports have their own, smaller budget: they are worth a lot once and
	 * nothing at all afterwards, and they must not eat the repair log's budget.
	 */
	function inspect(line: string): void {
		if (!settings().logDiagnostics || inspected >= MAX_INSPECTION) return
		inspected++
		console.warn(`[ToastGuard] ${line}`)
	}

	const inspector = createInspector(inspect)

	function describeError(error: unknown): string {
		if (error instanceof Error) return `${error.name}: ${error.message}`
		return String(error)
	}

	function repairOptions() {
		return {
			// No explicit default: a missing position inherits its sibling's,
			// and only falls back to DEFAULT_POSITION when nothing is usable.
			onInvalid: (reason: string, entry: unknown, index: number) =>
				diagnose(`repaired toast (${reason}) at ${index}`, entry),
		}
	}

	function patchComponent(module: LegacyModule, key: string): void {
		const component = module[key]
		if (typeof component !== 'function') return

		// A class component would break: React calls it with `new`, and a plain
		// wrapper cannot forward that without losing the prototype.
		if ((component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) return

		unpatch.push(
			api.patcher.instead(key, module, function (this: unknown, args: any[], original: AnyFunction) {
				try {
					return Reflect.apply(original, this, args)
				} catch (error) {
					// The interesting question is not *that* it threw, which the
					// logcat already answers, but what state it threw on.
					try {
						inspect(
							`${COMPONENT_NAME} threw on render ${renders} with props ${describeValue(args?.[0])}; last hook result: ${inspector.last}`,
						)
					} catch {
						// Never let a diagnostics bug replace the real error
					}
					throw error
				}
			}),
		)

		inspect(`instrumented ${key} as ${COMPONENT_NAME}`)
	}

	function patchHook(module: LegacyModule): boolean {
		if (typeof module.useToastContainer !== 'function') return false

		hookPatched = true

		// Sibling exports name the rest of the toast subsystem, and the component
		// that crashes is the one Hermes calls `ToastContainer`. A module with a
		// throwing getter must not stop the hook from being patched, so this is
		// best effort only.
		try {
			inspect(`hook module exports: ${describeModule(module)}`)

			// `DEFAULT_TOAST_POSITION` is what the container itself falls back
			// to, so it is the only correct value to complete a payload with.
			const candidate = module.DEFAULT_TOAST_POSITION
			if (typeof candidate === 'string' && candidate.length > 0) toastDefaultPosition = candidate

			for (const key of findComponentExports(module, COMPONENT_NAME)) patchComponent(module, key)
		} catch (error) {
			diagnose('could not inspect the toast module', error)
		}

		unpatch.push(
			api.patcher.instead(
				'useToastContainer',
				module,
				function (this: unknown, args: any[], original: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(original, this, args)

					renders++

					// The original hook is called straight through: swallowing an
					// exception raised inside it would desync React's hook list and
					// crash the next render with `areHookInputsEqual`.
					let raw: unknown
					const state = guardToastState(() => {
						try {
							raw = Reflect.apply(original, this, args)
							return raw
						} catch (error) {
							inspect(`useToastContainer threw on render ${renders}: ${describeError(error)}`)
							throw error
						}
					}, repairOptions())

					// Log what Discord handed over, not what was handed back: the
					// original shape is what names the fields to repair.
					inspector.observe(raw, renders)
					return state
				},
			),
		)

		return true
	}

	function patchDispatcher(module: LegacyModule, key: string): void {
		if (typeof module[key] !== 'function') return

		const keys = patchedDispatchers.get(module) ?? new Set<string>()
		if (keys.has(key)) return
		keys.add(key)
		patchedDispatchers.set(module, keys)

		dispatchersPatched++
		unpatch.push(
			api.patcher.instead(key, module, function (this: unknown, args: any[], original: AnyFunction) {
				if (!settings().sanitizeDispatcher) return Reflect.apply(original, this, args)

				// A dispatcher called without a payload still stores an entry
				// (`{toast: undefined, key}` in `currentToastMap`) that the
				// container cannot render, so the call is dropped rather than
				// forwarded.
				if (args?.[0] == null) {
					diagnose(`dropped a ${key} call with no toast payload`, { args: args?.length ?? 0 })
					return undefined
				}

				try {
					for (const candidate of [args?.[0], args?.[1]]) {
						if (ensurePosition(candidate, defaultPosition())) {
							diagnose('filled a missing toast position', candidate)
						}
					}
				} catch (error) {
					// Never make toast creation worse than it already is
					diagnose(`could not complete the ${key} payload`, error)
				}

				return Reflect.apply(original, this, args)
			}),
		)
	}

	/**
	 * Guards the store the container reads.
	 *
	 * The hook selects `state.currentToastMap.get(key)` and then reads
	 * `entry.toast.position` unguarded, so an entry stored without a payload
	 * crashes it. Repairing the slice on its way out of the store also heals
	 * entries that were queued before this plugin loaded.
	 */
	function patchStore(module: LegacyModule): void {
		if (typeof module.useToastStore !== 'function') return
		if (patchedStores.has(module)) return
		patchedStores.add(module)

		const store = module.useToastStore as AnyFunction
		storePatched = true

		unpatch.push(
			api.patcher.instead('useToastStore', module, function (this: unknown, args: any[], original: AnyFunction) {
				// The hook has to run no matter what: React tracks hooks by call
				// order, so skipping the call would desync the hook list.
				const entry = Reflect.apply(original, this, args)
				if (!settings().sanitizeContainer) return entry

				try {
					const repaired = repairToastEntry(entry)
					if (repaired !== entry && !reportedEmptyToast) {
						reportedEmptyToast = true
						diagnose(`dropped a toast entry with no payload: ${describeValue(entry)}`, entry)
					}
					return repaired
				} catch (error) {
					diagnose('could not repair the toast store entry', error)
					return entry
				}
			}),
		)

		// `instead` swaps the function object, but Discord also uses the store
		// directly (`useToastStore.getState()`), so its statics have to survive.
		inheritHelpers(module.useToastStore as AnyFunction, store)
	}

	/**
	 * Copies a function's own helpers (`getState`, `setState`, `subscribe`) onto
	 * the wrapper that replaced it.
	 *
	 * Losing them would break every caller that uses the store as an object,
	 * which is worse than the crash this plugin exists to stop.
	 */
	function inheritHelpers(target: AnyFunction, source: AnyFunction): void {
		for (const key of Object.getOwnPropertyNames(source)) {
			if (key === 'length' || key === 'name' || key === 'prototype') continue
			try {
				;(target as any)[key] = (source as any)[key]
			} catch (error) {
				diagnose(`could not keep ${key} reachable on the toast store`, error)
			}
		}
	}

	function findOne(key: string): LegacyModule | undefined {
		try {
			return api.metro.findByProps(key) ?? undefined
		} catch (error) {
			diagnose(`could not search modules for ${key}`, error)
			return undefined
		}
	}

	function findAll(key: string): LegacyModule[] {
		try {
			return api.metro.findByPropsAll(key) ?? []
		} catch (error) {
			diagnose(`could not search modules for ${key}`, error)
			return []
		}
	}

	function report(): void {
		if (finished) return
		finished = true

		if (settings().logDiagnostics) {
			console.log(
				`[ToastGuard] active (hook: ${hookPatched}, store: ${storePatched}, dispatchers: ${dispatchersPatched})`,
			)
		}

		if (!hookPatched) {
			console.warn(
				'[ToastGuard] could not find the toast container in this Discord build; nothing was patched',
			)
		}
	}

	function scan(): void {
		timer = undefined
		scans++

		if (!hookPatched) {
			const module = findOne(HOOK_KEYS[0])
			if (module) {
				try {
					patchHook(module)
				} catch (error) {
					diagnose('could not patch useToastContainer', error)
				}
			}
		}

		if (!storePatched) {
			for (const key of STORE_KEYS) {
				const module = findOne(key)
				if (!module) continue
				try {
					patchStore(module)
				} catch (error) {
					diagnose(`could not patch ${key}`, error)
				}
			}
		}

		if (dispatchersPatched === 0) {
			for (const key of DISPATCH_KEYS) {
				for (const module of findAll(key)) {
					try {
						patchDispatcher(module, key)
					} catch (error) {
						diagnose(`could not patch ${key}`, error)
					}
				}
			}
		}

		if ((hookPatched && storePatched && dispatchersPatched > 0) || scans >= MAX_SCANS) {
			report()
			return
		}

		// Modules can show up late on cold starts; poll for a bounded window.
		timer = setTimeout(scan, RETRY_INTERVAL)
		;(timer as any)?.unref?.()
	}

	function teardown(): void {
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined

		for (const undo of unpatch.splice(0)) {
			try {
				undo()
			} catch (error) {
				console.warn('[ToastGuard] could not restore a patch', error)
			}
		}
	}

	return {
		onLoad() {
			scan()
		},
		onUnload() {
			teardown()
		},
		settings: createSettings(api, storage),
	}
}

