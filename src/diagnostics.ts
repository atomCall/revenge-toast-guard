/**
 * Shape reporting for the plugin's log lines.
 *
 * The toast container of a given Discord build is Hermes bytecode, so the only
 * way to learn what a hook actually returns is to ask it at runtime. These
 * helpers turn any value into a short, stable description (`{toasts:undefined,
 * handlers:{…}}`) that is cheap to log and can be used as a de-duplication key,
 * so a screen that re-renders 60 times a second logs one line per shape instead
 * of one per render.
 *
 * Nothing here may throw: it runs inside a patched hook, and a diagnostics bug
 * must never take the toast container down.
 */

const MAX_DEPTH = 2
const MAX_ENTRIES = 3
const MAX_KEYS = 24
const MAX_LENGTH = 400
const MAX_STRING = 32

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const clamp = (text: string): string =>
	text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text

function describeString(value: string): string {
	const oneLine = value.replace(/\s+/g, ' ')
	return oneLine.length > MAX_STRING
		? `"${oneLine.slice(0, MAX_STRING)}…"`
		: `"${oneLine}"`
}

function describeArray(value: unknown[], depth: number, seen: Set<unknown>): string {
	const parts: string[] = []

	for (let index = 0; index < value.length && parts.length < MAX_ENTRIES; index++) {
		// A hole reads as `undefined`, which is exactly the entry the container
		// chokes on, so it is worth spelling out.
		parts.push(index in value ? describeValue(value[index], depth + 1, seen) : '<hole>')
	}

	if (value.length > MAX_ENTRIES) parts.push('…')
	return `array(${value.length})[${parts.join(',')}]`
}

function describeObject(value: Record<string, unknown>, depth: number, seen: Set<unknown>): string {
	if (seen.has(value)) return '<cycle>'
	if (depth > MAX_DEPTH) return '{…}'

	seen.add(value)
	const parts: string[] = []
	const keys = Object.keys(value)

	for (const key of keys.slice(0, MAX_KEYS)) {
		parts.push(`${key}:${describeValue(value[key], depth + 1, seen)}`)
	}

	if (keys.length > MAX_KEYS) parts.push(`…+${keys.length - MAX_KEYS}`)
	seen.delete(value)

	return `{${parts.join(',')}}`
}

/** Describes a value by shape: types, array lengths, holes, and key names. */
export function describeValue(value: unknown, depth = 0, seen = new Set<unknown>()): string {
	if (value === undefined) return 'undefined'
	if (value === null) return 'null'

	const kind = typeof value
	if (kind === 'string') return describeString(value as string)
	if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value)
	if (kind === 'function') {
		const name = (value as { name?: string }).name
		return name ? `fn:${name}` : 'fn'
	}
	if (kind === 'symbol') return 'symbol'

	if (Array.isArray(value)) return describeArray(value, depth, seen)
	if (depth > MAX_DEPTH) return '{…}'
	return describeObject(value as Record<string, unknown>, depth, seen)
}

/**
 * Describes a module's exports, e.g.
 * `default:fn:ToastContainer, useToastContainer:fn, handlers:object`.
 *
 * Sibling exports are how the rest of the toast subsystem (the store, the
 * component, the dispatchers) is discovered from a single finder hit.
 */
export function describeModule(module: unknown): string {
	if (!isPlainObject(module) && typeof module !== 'object') return describeValue(module)
	if (module === null) return 'null'

	const keys = Object.keys(module)
	const parts = keys
		.slice(0, MAX_KEYS)
		.map((key) => `${key}:${describeValue((module as Record<string, unknown>)[key], MAX_DEPTH - 1)}`)

	if (keys.length > MAX_KEYS) parts.push(`…+${keys.length - MAX_KEYS}`)
	return clamp(`{${parts.join(',')}}`)
}

/**
 * Names of the exports whose value is a function called `ToastContainer`.
 *
 * Matching on the function name is what makes the component reachable from
 * `findByProps('useToastContainer')`: Hermes keeps function names, and the
 * crash's component stack prints exactly that name.
 */
export function findComponentExports(module: unknown, name: string): string[] {
	if (!isPlainObject(module)) return []

	return Object.keys(module).filter((key) => {
		const value = module[key]
		return typeof value === 'function' && (value as { name?: string }).name === name
	})
}

export interface Inspector {
	/** The last logged shape, for the "what did it have when it threw" line. */
	readonly last: string
	/** How many distinct shapes have been logged so far. */
	readonly shapes: number
	/** Describes a hook result, logging each distinct shape at most once. */
	observe(state: unknown, render: number): void
}

/**
 * Rate-limits shape logging: one line per distinct shape, and nothing at all
 * once `maxShapes` lines have been written.
 *
 * `last` keeps the most recent *logged* shape, which is the one the container
 * threw on — a crash after the cap therefore still names the state it saw.
 */
export function createInspector(log: (line: string) => void, maxShapes = 10): Inspector {
	const seen = new Set<string>()
	let last = 'unknown'
	let shapes = 0

	return {
		get last() {
			return last
		},
		get shapes() {
			return shapes
		},
		observe(state: unknown, render: number) {
			if (shapes >= maxShapes) return

			let description: string
			try {
				description = describeValue(state)
			} catch {
				return
			}

			last = description
			if (seen.has(description)) return

			seen.add(description)
			shapes++
			log(`hook result #${shapes} (render ${render}): ${description}`)
		},
	}
}
