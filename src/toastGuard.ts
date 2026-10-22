/**
 * Framework-free core of Toast Guard.
 *
 * Discord's `useToastContainer` reads `position` off entries of the toast list.
 * When the list contains a stale/undefined entry, that read throws
 * `TypeError: Cannot read property 'position' of undefined` and takes the whole
 * toast container (and the screen rendering it) down.
 *
 * Repairing the list has one hard rule:
 *
 *   the repaired list must have the same length and the same order as the input.
 *
 * Anything the container derives per entry (children keys, and in some builds
 * hooks) is tied to the list shape, and React tracks hooks positionally: if a
 * component runs a different number of hooks than on the previous render,
 * `updateMemo` reads a `useMemo` slot that used to hold a `useState`/`useEffect`
 * and throws `TypeError: Cannot read property 'length' of undefined` inside
 * `areHookInputsEqual`. So entries are never dropped, deduplicated or
 * reordered: unrenderable entries are replaced *in place* by an inert
 * placeholder, and a missing `position` is filled on a copy of that entry.
 *
 * The same rule is why `guardToastState` never catches errors coming out of the
 * hook itself: a hook that throws halfway leaves React's hook list short for
 * this render, and swallowing the error only postpones the crash to the next.
 */

export const DEFAULT_POSITION = 'bottom'

export type ToastPosition = string | number

export interface ToastLike {
	id?: unknown
	position?: unknown
	[key: string]: unknown
}

export type RepairReason = 'not-an-array' | 'not-an-object' | 'missing-position' | 'duplicate-id'

export interface RepairOptions {
	defaultPosition?: ToastPosition
	onInvalid?: (reason: RepairReason, entry: unknown, index: number) => void
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

const placeholders = new Map<number, ToastLike>()

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

/**
 * Repairs one list entry without ever removing it.
 *
 * @returns the original entry when it is already renderable, otherwise a
 *   replacement to slot into the same index.
 */
export function repairToast(entry: unknown, index = 0, options: RepairOptions = {}): ToastLike {
	const defaultPosition = options.defaultPosition ?? DEFAULT_POSITION

	if (!isObject(entry)) {
		options.onInvalid?.('not-an-object', entry, index)
		return placeholderFor(index, defaultPosition)
	}

	if (hasUsablePosition(entry.position)) return entry as ToastLike

	options.onInvalid?.('missing-position', entry, index)

	try {
		return { ...entry, position: defaultPosition }
	} catch {
		// Spreading threw (an exotic proxy): the placeholder is still renderable.
		return placeholderFor(index, defaultPosition)
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

function placeholderFor(index: number, position: ToastPosition): ToastLike {
	const cached = placeholders.get(index)
	if (cached && cached.position === position) return cached

	// Inert on purpose: a position (so nothing reads `undefined.position`) and no
	// content, so if it ever renders it renders an empty toast for a frame.
	const placeholder: ToastLike = {
		id: `toast-guard-placeholder-${index}`,
		position,
		content: null,
	}
	placeholders.set(index, placeholder)
	return placeholder
}

/**
 * Repairs every entry of a toast list, preserving its length and order.
 *
 * Returns the input array itself when every entry is already renderable, so a
 * healthy container keeps referential equality across renders.
 */
export function repairToasts(list: unknown, options: RepairOptions = {}): ToastLike[] {
	if (!Array.isArray(list)) {
		options.onInvalid?.('not-an-array', list, -1)
		return []
	}

	// Holes are what makes a list read as `undefined` while `length` says
	// otherwise, so iterate by index instead of with `map`/`forEach`.
	if (list.length === 0) return list as ToastLike[]

	const defaultPosition = options.defaultPosition ?? inferDefaultPosition(list)
	const seen = new Set<unknown>()

	let repaired: ToastLike[] | undefined
	for (let index = 0; index < list.length; index++) {
		const entry = list[index]
		const next = repairToast(entry, index, { ...options, defaultPosition })

		if (isObject(entry) && hasUsableId(entry)) {
			if (seen.has(entry.id)) {
				// A stale entry survived a removal. Keep it: dropping it would
				// change the length, and Discord's reducer still removes it.
				options.onInvalid?.('duplicate-id', entry, index)
			}
			seen.add(entry.id)
		}

		if (next === entry) continue
		if (!repaired) repaired = list.slice()
		repaired[index] = next
	}

	return repaired ?? (list as ToastLike[])
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

/**
 * Repairs a hook result. Returns the very same object when nothing needed
 * fixing, so consumers comparing by identity do not re-render.
 */
export function repairToastState(state: unknown, options: RepairOptions = {}): ToastState {
	// A tuple-shaped return (e.g. `[state, api]`) has no `toasts` field to fix;
	// spreading it into an object would only break the consumer.
	if (Array.isArray(state)) return state as unknown as ToastState
	if (!isObject(state)) return createSafeToastState()

	const toasts = repairToasts(state.toasts, options)
	const handlers = normalizeHandlers(state.handlers)

	if (toasts === state.toasts && handlers === state.handlers) return state as ToastState
	return { ...state, toasts, handlers }
}

/**
 * Runs the original hook and repairs its result.
 *
 * The call is deliberately *not* wrapped in a try/catch: React tracks hooks by
 * call order, so swallowing an exception raised halfway through a hook would
 * leave this render with fewer hooks than the previous one, which resurfaces as
 * `Cannot read property 'length' of undefined` from `areHookInputsEqual` on the
 * next render. A throwing hook has to unwind the render instead.
 */
export function guardToastState(invoke: () => unknown, options: RepairOptions = {}): ToastState {
	return repairToastState(invoke(), options)
}

