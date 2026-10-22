import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { before, instead } from '@revenge-mod/patcher'
import { DEFAULT_SETTINGS, type Settings } from './config'
import { createInspector, describeModule, describeValue, findComponentExports } from './diagnostics'
import SettingsComponent from './settings'
import { ensurePosition, guardToastState } from './toastGuard'

type AnyRecord = Record<string, any>
type AnyFunction = (...args: any[]) => any

const MAX_DIAGNOSTICS = 20
const MAX_INSPECTION = 12

const COMPONENT_NAME = 'ToastContainer'

const HOOK_KEYS = ['useToastContainer'] as const
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

			dispatchersPatched++
			cleanup(
				before(module, key, ([payload, options]: any[]) => {
					if (!settings().sanitizeDispatcher) return

					try {
						for (const candidate of [payload, options]) {
							if (ensurePosition(candidate)) {
								diagnose('filled a missing toast position', candidate)
							}
						}
					} catch (error) {
						// Never make toast creation worse than it already is
						diagnose(`could not complete the ${key} payload`, error)
					}
				}),
			)
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
				`[ToastGuard] active (hook: ${hookPatched}, dispatchers: ${dispatchersPatched})`,
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
