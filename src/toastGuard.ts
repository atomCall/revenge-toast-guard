/**
 * Framework-free core of Toast Guard.
 *
 * Discord's `useToastContainer` reads `position` off entries of the toast list.
 * When the list contains a stale/undefined entry, that read throws
 * `TypeError: Cannot read property 'position' of undefined` and takes the whole
 * toast container (and the screen rendering it) down.
 *
 * These helpers make the data and the hook result safe to render:
 * - drop entries that cannot be rendered,
 * - fill a missing `position` (inheriting it from a sibling when possible),
 * - guarantee the handlers the container calls always exist.
 */

export const DEFAULT_POSITION = 'bottom'

export type ToastPosition = string | number

export interface ToastLike {
	id?: unknown
	position?: unknown
	[key: string]: unknown
}

export type ToastSanitizeResult =
	| { ok: true; toast: ToastLike }
	| { ok: false; reason: 'not-an-object' | 'missing-id' | 'duplicate-id' }

export interface SanitizeOptions {
	defaultPosition?: ToastPosition
	onInvalid?: (reason: string, entry: unknown) => void
}

export interface ToastHandlers {
	updateHeight: (...args: unknown[]) => unknown
	startPause: (...args: unknown[]) => unknown
	endPause: (...args: unknown[]) => unknown
	calculateOffset: (...args: unknown[]) => number
}

export interface ToastState {
	toasts: ToastLike[]
	handlers: ToastHandlers
	[key: string]: unknown
}

export interface GuardOptions extends SanitizeOptions {
	fallback?: ToastState
	onError?: (error: unknown) => void
}

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
	typeof value === 'function'

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const hasUsableId = (entry: Record<string, unknown>) =>
	(typeof entry.id === 'string' && entry.id.length > 0) ||
	(typeof entry.id === 'number' && Number.isFinite(entry.id))

const hasUsablePosition = (value: unknown) => value != null && value !== ''

const PAYLOAD_KEYS = ['content', 'message', 'title', 'type', 'position'] as const

const isToastPayload = (value: unknown): value is Record<string, unknown> =>
	isObject(value) && PAYLOAD_KEYS.some(key => key in value)

/**
 * Root-cause fix: give a toast payload its missing `position` before Discord
 * enqueues it, so the container never receives an entry it cannot render.
 *
 * @returns `true` when the payload was completed, `false` when it was left alone.
 */
export function ensurePosition(
	target: unknown,
	defaultPosition: ToastPosition = DEFAULT_POSITION,
): boolean {
	if (!isToastPayload(target)) return false
	if (hasUsablePosition(target.position)) return false

	try {
		target.position = defaultPosition
		return true
	} catch {
		// Frozen/sealed payloads belong to someone else; leave them as they are.
		return false
	}
}

export function sanitizeToast(
	entry: unknown,
	options: SanitizeOptions = {},
): ToastSanitizeResult {
	if (!isObject(entry)) return { ok: false, reason: 'not-an-object' }
	if (!hasUsableId(entry)) return { ok: false, reason: 'missing-id' }
	if (hasUsablePosition(entry.position)) return { ok: true, toast: entry as ToastLike }

	return {
		ok: true,
		toast: { ...entry, position: options.defaultPosition ?? DEFAULT_POSITION },
	}
}

export function inferDefaultPosition(list: unknown): ToastPosition {
	if (!Array.isArray(list)) return DEFAULT_POSITION

	for (const entry of list) {
		if (!isObject(entry)) continue
		if (hasUsablePosition(entry.position)) return entry.position as ToastPosition
	}

	return DEFAULT_POSITION
}

export function sanitizeToasts(list: unknown, options: SanitizeOptions = {}): ToastLike[] {
	if (!Array.isArray(list)) {
		options.onInvalid?.('not-an-array', list)
		return []
	}

	const defaultPosition = options.defaultPosition ?? inferDefaultPosition(list)
	const byId = new Map<unknown, ToastLike>()

	for (const entry of list) {
		const result = sanitizeToast(entry, { defaultPosition })

		if (!result.ok) {
			options.onInvalid?.(result.reason, entry)
			continue
		}

		// A duplicated id means a stale entry survived a removal: keep the newest one
		if (byId.has(result.toast.id)) {
			options.onInvalid?.('duplicate-id', entry)
			byId.delete(result.toast.id)
		}

		byId.set(result.toast.id, result.toast)
	}

	return [...byId.values()]
}

export function normalizeHandlers(handlers: unknown): ToastHandlers {
	if (!isObject(handlers)) return createSafeHandlers()

	const source = handlers as Partial<ToastHandlers>
	const complete =
		isFunction(source.updateHeight) &&
		isFunction(source.startPause) &&
		isFunction(source.endPause) &&
		isFunction(source.calculateOffset)

	if (complete) return handlers as unknown as ToastHandlers

	return {
		updateHeight: isFunction(source.updateHeight) ? source.updateHeight : () => undefined,
		startPause: isFunction(source.startPause) ? source.startPause : () => undefined,
		endPause: isFunction(source.endPause) ? source.endPause : () => undefined,
		calculateOffset: isFunction(source.calculateOffset)
			? (source.calculateOffset as (...args: unknown[]) => number)
			: () => 0,
	}
}

function createSafeHandlers(): ToastHandlers {
	return {
		updateHeight: () => undefined,
		startPause: () => undefined,
		endPause: () => undefined,
		calculateOffset: () => 0,
	}
}

export function createSafeToastState(): ToastState {
	return { toasts: [], handlers: createSafeHandlers() }
}

export function normalizeToastState(state: unknown, options: SanitizeOptions = {}): ToastState {
	// A tuple-shaped return (e.g. `[state, api]`) has no `toasts` field to fix;
	// spreading it into an object would only break the consumer.
	if (Array.isArray(state)) return state as unknown as ToastState
	if (!isObject(state)) return createSafeToastState()

	return {
		...state,
		toasts: sanitizeToasts(state.toasts, options),
		handlers: normalizeHandlers(state.handlers),
	}
}

/**
 * Runs the original hook and guarantees a renderable result.
 * A throwing hook must never take the container down, so failures fall back to
 * the last known good state (or an empty one) and are reported out of band.
 */
export function guardToastState(
	invoke: () => unknown,
	options: GuardOptions = {},
): ToastState {
	try {
		return normalizeToastState(invoke(), options)
	} catch (error) {
		try {
			options.onError?.(error)
		} catch {
			// Reporting must never break the guard itself
		}

		return options.fallback ?? createSafeToastState()
	}
}

