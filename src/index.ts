import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { before, instead } from '@revenge-mod/patcher'
import { DEFAULT_SETTINGS, type Settings } from './config'
import SettingsComponent from './settings'
import { ensurePosition, guardToastState, type ToastState } from './toastGuard'

type AnyRecord = Record<string, any>
type AnyFunction = (...args: any[]) => any

const MAX_DIAGNOSTICS = 20

const HOOK_KEYS = ['useToastContainer'] as const
const COMPONENT_KEYS = ['ToastContainer'] as const
const DISPATCH_KEYS = ['showToast', 'addToast', 'pushToast', 'enqueueToast', 'createToast'] as const

/** Class components cannot be called with `Reflect.apply`. */
const isCallableComponent = (value: unknown): value is AnyFunction =>
	typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value))

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_SETTINGS,
	},

	start({ cleanup, jsonStorage: storage }) {
		// A cache written by an older version may miss keys; merge over defaults
		const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...storage.cache })

		let diagnostics = 0
		let dispatchersPatched = 0
		let lastGood: ToastState | undefined
		let hookPatched = false
		let componentPatched = false

		function diagnose(label: string, detail: unknown): void {
			if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS) return
			diagnostics++
			console.warn(`[ToastGuard] ${label}`, detail)
		}

		function guardOptions() {
			return {
				// No explicit default: a missing position inherits its sibling's,
				// and only falls back to DEFAULT_POSITION when nothing is usable.
				onInvalid: (reason: string, entry: unknown) => diagnose(`dropped toast (${reason})`, entry),
				onError: (error: unknown) => diagnose('toast container crashed, using safe state', error),
			}
		}

		function patchHook(module: AnyRecord): boolean {
			if (typeof module.useToastContainer !== 'function') return false

			hookPatched = true
			cleanup(
				instead(module, 'useToastContainer', function (this: unknown, args: any[], orig: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(orig, this, args)

					const state = guardToastState(() => Reflect.apply(orig, this, args), {
						...guardOptions(),
						// Keeping the last good state avoids a flash of empty toasts
						// and keeps the container's hook output shape stable.
						fallback: lastGood,
					})

					lastGood = state
					return state
				}),
			)

			return true
		}

		function patchComponent(module: AnyRecord): boolean {
			if (!isCallableComponent(module.ToastContainer)) return false

			componentPatched = true
			cleanup(
				instead(module, 'ToastContainer', function (this: unknown, args: any[], orig: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(orig, this, args)

					try {
						return Reflect.apply(orig, this, args)
					} catch (error) {
						// Last line of defence: the screen survives, the toast does not.
						diagnose('toast container component threw, rendering nothing', error)
						return null
					}
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

		cleanup(
			getModules(withProps(...COMPONENT_KEYS), (module: AnyRecord) => {
				if (hookPatched || componentPatched) return
				try {
					patchComponent(module)
				} catch (error) {
					diagnose('could not patch ToastContainer', error)
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
				`[ToastGuard] active (hook: ${hookPatched}, component: ${componentPatched}, dispatchers: ${dispatchersPatched})`,
			)
		}

		if (!hookPatched && !componentPatched) {
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
