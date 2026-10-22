import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { instead } from '@revenge-mod/patcher'
import { DEFAULT_SETTINGS, type Settings } from './config'
import { createInspector, describeModule, describeValue, findComponentExports } from './diagnostics'
import SettingsComponent from './settings'
import {
	DEFAULT_POSITION,
	ensurePosition,
	guardToastState,
	repairToastEntry,
	type ToastPosition,
} from './toastGuard'

type AnyRecord = Record<string, any>
type AnyFunction = (...args: any[]) => any

const MAX_DIAGNOSTICS = 20
const MAX_INSPECTION = 12

const COMPONENT_NAME = 'ToastContainer'

const HOOK_KEYS = ['useToastContainer'] as const
const STORE_KEYS = ['useToastStore'] as const
const DISPATCH_KEYS = ['showToast', 'addToast', 'pushToast', 'enqueueToast', 'createToast'] as const

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_SETTINGS,
	},

	start({ cleanup, jsonStorage: storage }) {
		// A cache written by an older version may miss keys; merge over defaults
		const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...storage.cache })

		let diagnostics = 0
		let inspected = 0
		let renders = 0
		let dispatchersPatched = 0
		let hookPatched = false
		let storePatched = false
		let reportedEmptyToast = false

		/** The container's own default, used to complete payloads. */
		let toastDefaultPosition: ToastPosition | undefined

		const patchedDispatchers = new WeakMap<AnyRecord, Set<string>>()
		const patchedStores = new WeakSet<AnyRecord>()

		const defaultPosition = (): ToastPosition => toastDefaultPosition ?? DEFAULT_POSITION

		function diagnose(label: string, detail: unknown): void {
			if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS) return
			diagnostics++
			console.warn(`[ToastGuard] ${label}`, detail)
		}

		/** Shape reports have their own budget; see the legacy build for why. */
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

		function patchComponent(module: AnyRecord, key: string): void {
			const component = module[key]
			if (typeof component !== 'function') return
			if (component.prototype?.isReactComponent) return

			cleanup(
				instead(module, key, function (this: unknown, args: any[], orig: AnyFunction) {
					try {
						return Reflect.apply(orig, this, args)
					} catch (error) {
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

		function patchHook(module: AnyRecord): boolean {
			if (typeof module.useToastContainer !== 'function') return false

			hookPatched = true

			// Best effort: a module with a throwing getter must not stop the hook
			// itself from being patched.
			try {
				inspect(`hook module exports: ${describeModule(module)}`)

				// `DEFAULT_TOAST_POSITION` is what the container itself falls
				// back to, so it is the only correct value to complete with.
				const candidate = module.DEFAULT_TOAST_POSITION
				if (typeof candidate === 'string' && candidate.length > 0) toastDefaultPosition = candidate

				for (const key of findComponentExports(module, COMPONENT_NAME)) patchComponent(module, key)
			} catch (error) {
				diagnose('could not inspect the toast module', error)
			}

			cleanup(
				instead(module, 'useToastContainer', function (this: unknown, args: any[], orig: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(orig, this, args)

					renders++

					// The original hook is called straight through: swallowing an
					// exception raised inside it would desync React's hook list and
					// crash the next render with `areHookInputsEqual`.
					let raw: unknown
					const state = guardToastState(() => {
						try {
							raw = Reflect.apply(orig, this, args)
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
				}),
			)

			return true
		}

		function patchDispatcher(module: AnyRecord, key: string): void {
			if (typeof module[key] !== 'function') return

			const keys = patchedDispatchers.get(module) ?? new Set<string>()
			if (keys.has(key)) return
			keys.add(key)
			patchedDispatchers.set(module, keys)

			dispatchersPatched++
			cleanup(
				instead(module, key, function (this: unknown, args: any[], orig: AnyFunction) {
					if (!settings().sanitizeDispatcher) return Reflect.apply(orig, this, args)

					// A dispatcher called without a payload still stores an entry
					// (`{toast: undefined, key}` in `currentToastMap`) that the
					// container cannot render, so the call is dropped rather
					// than forwarded.
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

					return Reflect.apply(orig, this, args)
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
		function patchStore(module: AnyRecord): void {
			if (typeof module.useToastStore !== 'function') return
			if (patchedStores.has(module)) return
			patchedStores.add(module)

			const store = module.useToastStore as AnyFunction
			storePatched = true

			cleanup(
				instead(module, 'useToastStore', function (this: unknown, args: any[], orig: AnyFunction) {
					// The hook has to run no matter what: React tracks hooks by
					// call order, so skipping the call would desync the list.
					const entry = Reflect.apply(orig, this, args)
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

			// `instead` swaps the function object, but Discord also uses the
			// store directly (`useToastStore.getState()`), so its statics have
			// to survive.
			inheritHelpers(module.useToastStore as AnyFunction, store)
		}

		/**
		 * Copies a function's own helpers (`getState`, `setState`, `subscribe`)
		 * onto the wrapper that replaced it. Losing them would break every
		 * caller that uses the store as an object.
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

		cleanup(
			getModules(withProps(...HOOK_KEYS), (module: AnyRecord) => {
				if (hookPatched) return
				try {
					patchHook(module)
				} catch (error) {
					diagnose('could not patch useToastContainer', error)
				}
			}),
		)

		for (const key of STORE_KEYS) {
			cleanup(
				getModules(withProps(key), (module: AnyRecord) => {
					try {
						patchStore(module)
					} catch (error) {
						diagnose(`could not patch ${key}`, error)
					}
				}),
			)
		}

		for (const key of DISPATCH_KEYS) {
			cleanup(
				getModules(withProps(key), (module: AnyRecord) => {
					try {
						patchDispatcher(module, key)
					} catch (error) {
						diagnose(`could not patch ${key}`, error)
					}
				}),
			)
		}

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
	},

	stop({ plugin }) {
		plugin.requireReload()
	},

	SettingsComponent,
})
