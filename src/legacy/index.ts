import { DEFAULT_SETTINGS, type Settings } from '../config'
import { ensurePosition, guardToastState, type ToastState } from '../toastGuard'
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
const RETRY_INTERVAL = 1_000
const MAX_SCANS = 15

const HOOK_KEYS = ['useToastContainer'] as const
const COMPONENT_KEYS = ['ToastContainer'] as const
const DISPATCH_KEYS = ['showToast', 'addToast', 'pushToast', 'enqueueToast', 'createToast'] as const

/** Class components cannot be called with `Reflect.apply`. */
const isCallableComponent = (value: unknown): value is AnyFunction =>
	typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value))

export default function ToastGuard(): LegacyPlugin {
	// The loader passes a per-plugin copy of the API (it carries `plugin.storage`)
	const api: LegacyApi =
		typeof vendetta === 'undefined' ? (globalThis as any).vendetta : vendetta
	const storage = (api.plugin?.storage ?? {}) as Partial<Settings>

	// A cache written by an older version may miss keys; merge over defaults
	const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...storage })

	let diagnostics = 0
	let dispatchersPatched = 0
	let lastGood: ToastState | undefined
	let hookPatched = false
	let componentPatched = false
	let scans = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let finished = false

	const unpatch: (() => unknown)[] = []
	const patchedDispatchers = new WeakMap<LegacyModule, Set<string>>()

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

	function patchHook(module: LegacyModule): boolean {
		if (typeof module.useToastContainer !== 'function') return false

		hookPatched = true
		unpatch.push(
			api.patcher.instead(
				'useToastContainer',
				module,
				function (this: unknown, args: any[], original: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(original, this, args)

					const state = guardToastState(() => Reflect.apply(original, this, args), {
						...guardOptions(),
						// Keeping the last good state avoids a flash of empty toasts
						// and keeps the container's hook output shape stable.
						fallback: lastGood,
					})

					lastGood = state
					return state
				},
			),
		)

		return true
	}

	function patchComponent(module: LegacyModule): boolean {
		if (!isCallableComponent(module.ToastContainer)) return false

		componentPatched = true
		unpatch.push(
			api.patcher.instead(
				'ToastContainer',
				module,
				function (this: unknown, args: any[], original: AnyFunction) {
					if (!settings().sanitizeContainer) return Reflect.apply(original, this, args)

					try {
						return Reflect.apply(original, this, args)
					} catch (error) {
						// Last line of defence: the screen survives, the toast does not.
						diagnose('toast container component threw, rendering nothing', error)
						return null
					}
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
			api.patcher.before(key, module, function (this: unknown, args: any[]) {
				if (!settings().sanitizeDispatcher) return

				try {
					for (const candidate of [args?.[0], args?.[1]]) {
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
				`[ToastGuard] active (hook: ${hookPatched}, component: ${componentPatched}, dispatchers: ${dispatchersPatched})`,
			)
		}

		if (!hookPatched && !componentPatched) {
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

		if (!hookPatched && !componentPatched) {
			const module = findOne(COMPONENT_KEYS[0])
			if (module) {
				try {
					patchComponent(module)
				} catch (error) {
					diagnose('could not patch ToastContainer', error)
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

		const found = hookPatched || componentPatched
		if ((found && dispatchersPatched > 0) || scans >= MAX_SCANS) {
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

