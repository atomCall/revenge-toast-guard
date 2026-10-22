import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { before, instead } from '@revenge-mod/patcher'
import { DEFAULT_SETTINGS, type Settings } from './config'
import SettingsComponent from './settings'
import { ensurePosition, guardToastState } from './toastGuard'

type AnyRecord = Record<string, any>
type AnyFunction = (...args: any[]) => any

const MAX_DIAGNOSTICS = 20

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
		let dispatchersPatched = 0
		let hookPatched = false

		function diagnose(label: string, detail: unknown): void {
			if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS) return
			diagnostics++
			console.warn(`[ToastGuard] ${label}`, detail)
		}

		function repairOptions() {
			return {
				// No explicit default: a missing position inherits its sibling's,
				// and only falls back to DEFAULT_POSITION when nothing is usable.
				onInvalid: (reason: string, entry: unknown, index: number) =>
					diagnose(`repaired toast (${reason}) at ${index}`, entry),
			}
		}

		function patchHook(module: AnyRecord): boolean {
			if (typeof module.useToastContainer !== 'function') return false

			hookPatched = true
			cleanup(
				instead(module, 'useToastContainer', function (this: unknown, args: any[], orig: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(orig, this, args)

					// The original hook is called straight through: swallowing an
					// exception raised inside it would desync React's hook list and
					// crash the next render with `areHookInputsEqual`.
					return guardToastState(() => Reflect.apply(orig, this, args), repairOptions())
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
