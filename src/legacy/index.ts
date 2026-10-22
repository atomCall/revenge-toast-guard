import { DEFAULT_SETTINGS, type Settings } from '../config'
import { createInspector, describeModule, describeValue, findComponentExports } from '../diagnostics'
import { ensurePosition, guardToastState } from '../toastGuard'
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
		// that crashes is the one Hermes calls `ToastContainer`.
		inspect(`hook module exports: ${describeModule(module)}`)
		for (const key of findComponentExports(module, COMPONENT_NAME)) patchComponent(module, key)

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
				`[ToastGuard] active (hook: ${hookPatched}, dispatchers: ${dispatchersPatched})`,
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

		if ((hookPatched && dispatchersPatched > 0) || scans >= MAX_SCANS) {
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

