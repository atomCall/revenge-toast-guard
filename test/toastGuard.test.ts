import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createSafeToastState,
	DEFAULT_POSITION,
	ensurePosition,
	guardToastState,
	inferDefaultPosition,
	normalizeHandlers,
	repairToast,
	repairToastState,
	repairToasts,
} from '../src/toastGuard.ts'

test('repairToast keeps an already valid toast untouched', () => {
	const toast = { id: 'a', position: 'bottom', content: 'hi' }

	assert.equal(repairToast(toast), toast)
})

test('repairToast fills a missing position with the default', () => {
	const repaired = repairToast({ id: 'a', content: 'hi' })

	assert.equal(repaired.position, DEFAULT_POSITION)
	assert.equal(repaired.content, 'hi')
})

test('repairToast fills an empty position', () => {
	assert.equal(repairToast({ id: 'a', position: '' }).position, DEFAULT_POSITION)
})

test('repairToast keeps non-string positions that are not empty', () => {
	assert.equal(repairToast({ id: 'a', position: 3 }).position, 3)
})

test('repairToast does not mutate the toast it repairs', () => {
	const toast = { id: 'a' }

	repairToast(toast)

	assert.equal('position' in toast, false)
})

test('repairToast replaces unrenderable entries with a renderable placeholder', () => {
	for (const value of [undefined, null, 42, 'toast', true]) {
		const repaired = repairToast(value, 2, { defaultPosition: 'top' })

		assert.equal(typeof repaired.id, 'string')
		assert.equal(repaired.position, 'top')
		// The same slot keeps the same placeholder, so React keys stay stable
		assert.equal(repairToast(value, 2, { defaultPosition: 'top' }), repaired)
	}
})

test('repairToast reports what it had to replace', () => {
	const reasons: string[] = []

	repairToast(undefined, 1, { onInvalid: reason => reasons.push(reason) })
	repairToast({ id: 'a' }, 0, { onInvalid: reason => reasons.push(reason) })

	assert.deepEqual(reasons, ['not-an-object', 'missing-position'])
})

test('repairToasts keeps the length and the order of the list', () => {
	const input = [{ id: 'a', position: 'top' }, undefined, null, { id: 'b' }]

	const toasts = repairToasts(input)

	assert.equal(toasts.length, input.length)
	assert.equal(toasts[0].id, 'a')
	assert.equal(typeof toasts[1].id, 'string')
	assert.equal(typeof toasts[2].id, 'string')
	assert.equal(toasts[3].id, 'b')
	// A missing position inherits its sibling's instead of guessing one
	assert.equal(toasts[3].position, 'top')
})

test('repairToasts fills the holes of a sparse list', () => {
	const input: unknown[] = new Array(3)
	input[1] = { id: 'a', position: 'top' }

	const toasts = repairToasts(input)

	assert.equal(toasts.length, 3)
	for (const toast of toasts) assert.equal(typeof toast.id, 'string')
})

test('repairToasts returns the input array when everything is renderable', () => {
	const input = [{ id: 'a', position: 'top' }]

	assert.equal(repairToasts(input), input)
	assert.deepEqual(repairToasts([]), [])
})

test('repairToasts does not mutate its input', () => {
	const input = [{ id: 'a' }, { id: 'b', position: 'top' }]
	const snapshot = structuredClone(input)

	const toasts = repairToasts(input)

	assert.deepEqual(input, snapshot)
	assert.notEqual(toasts[0], input[0])
})

test('repairToasts respects an explicit default over the siblings', () => {
	const toasts = repairToasts([{ id: 'a', position: 'bottom' }, { id: 'b' }], {
		defaultPosition: 'top',
	})

	assert.equal(toasts[1].position, 'top')
})

test('repairToasts returns an empty list for non-array input', () => {
	const reasons: string[] = []
	const onInvalid = (reason: string) => reasons.push(reason)

	assert.deepEqual(repairToasts(undefined, { onInvalid }), [])
	assert.deepEqual(repairToasts({ 0: { id: 'a' } }, { onInvalid }), [])
	assert.deepEqual(reasons, ['not-an-array', 'not-an-array'])
})

test('repairToasts reports a duplicated id but keeps both entries', () => {
	const first = { id: 'a', position: 'top', content: 'old' }
	const last = { id: 'a', position: 'bottom', content: 'new' }
	const reasons: string[] = []

	const toasts = repairToasts([first, { id: 'b', position: 'top' }, last], {
		onInvalid: reason => reasons.push(reason),
	})

	// Same length: dropping the stale entry would change how many items (and,
	// in some builds, how many hooks) the container renders.
	assert.equal(toasts.length, 3)
	assert.equal(toasts[2], last)
	assert.deepEqual(reasons, ['duplicate-id'])
})

test('inferDefaultPosition finds the first usable position', () => {
	assert.equal(
		inferDefaultPosition([undefined, { id: 'a', position: '' }, { id: 'b', position: 'top' }]),
		'top',
	)
	assert.equal(inferDefaultPosition([{ id: 'a' }]), DEFAULT_POSITION)
	assert.equal(inferDefaultPosition('nope'), DEFAULT_POSITION)
})

test('normalizeHandlers fills missing handlers with callable no-ops', () => {
	const handlers = normalizeHandlers(undefined)

	assert.doesNotThrow(() => handlers.updateHeight('a', 10))
	assert.doesNotThrow(() => handlers.startPause())
	assert.doesNotThrow(() => handlers.endPause())
	assert.equal(handlers.calculateOffset({ id: 'a' }), 0)
})

test('normalizeHandlers keeps the original handlers', () => {
	const original = {
		updateHeight: () => 'updated',
		startPause: () => 'paused',
		endPause: () => 'ended',
		calculateOffset: () => 42,
	}

	assert.equal(normalizeHandlers(original), original)
	assert.equal(normalizeHandlers(original).calculateOffset(), 42)
})

test('normalizeHandlers replaces non-function handlers', () => {
	const handlers = normalizeHandlers({ updateHeight: 'nope', calculateOffset: null })

	assert.doesNotThrow(() => handlers.updateHeight('a', 1))
	assert.equal(handlers.calculateOffset(), 0)
})

test('createSafeToastState returns an empty, renderable state', () => {
	const state = createSafeToastState()

	assert.deepEqual(state.toasts, [])
	assert.equal(state.handlers.calculateOffset(), 0)
})

test('repairToastState preserves extra state fields and repairs toasts', () => {
	const state = repairToastState({
		toasts: [{ id: 'a' }, undefined],
		handlers: { calculateOffset: () => 5 },
		pausedAt: 123,
	})

	assert.equal(state.pausedAt, 123)
	assert.equal(state.toasts.length, 2)
	assert.equal(state.handlers.calculateOffset(), 5)
	assert.equal(typeof state.handlers.endPause, 'function')
})

test('repairToastState returns the same object when nothing needs fixing', () => {
	const handlers = {
		updateHeight: () => undefined,
		startPause: () => undefined,
		endPause: () => undefined,
		calculateOffset: () => 0,
	}
	const state = { toasts: [{ id: 'a', position: 'top' }], handlers }

	assert.equal(repairToastState(state), state)
})

test('repairToastState leaves an unexpected shape alone', () => {
	const tuple = [{ id: 'a', position: 'top' }, { dismiss: () => {} }]

	assert.equal(repairToastState(tuple), tuple)
})

test('guardToastState returns the repaired state of a healthy hook', () => {
	const state = guardToastState(() => ({ toasts: [{ id: 'a' }] }))

	assert.equal(state.toasts.length, 1)
	assert.equal(state.toasts[0].position, DEFAULT_POSITION)
	assert.equal(typeof state.handlers.calculateOffset, 'function')
})

test('guardToastState lets a throwing hook unwind the render', () => {
	// Swallowing it would leave React's hook list short for this render, which
	// resurfaces as `areHookInputsEqual` reading `undefined.length` next time.
	assert.throws(
		() =>
			guardToastState(() => {
				throw new Error('hook failed')
			}),
		/hook failed/,
	)
})

test('guardToastState tolerates hooks returning nothing usable', () => {
	for (const value of [undefined, null, 'nope', 0]) {
		const state = guardToastState(() => value)

		assert.deepEqual(state.toasts, [])
		assert.equal(state.handlers.calculateOffset(), 0)
	}
})

test('ensurePosition fills a missing position on a toast payload', () => {
	const payload: Record<string, unknown> = { content: 'hello' }

	assert.equal(ensurePosition(payload), true)
	assert.equal(payload.position, DEFAULT_POSITION)
})

test('ensurePosition leaves an existing position untouched', () => {
	const payload: Record<string, unknown> = { content: 'hello', position: 'top' }

	assert.equal(ensurePosition(payload, 'bottom'), false)
	assert.equal(payload.position, 'top')
})

test('ensurePosition treats an empty position as missing', () => {
	const payload: Record<string, unknown> = { content: 'hello', position: '' }

	assert.equal(ensurePosition(payload, 'top'), true)
	assert.equal(payload.position, 'top')
})

test('ensurePosition respects an explicit default position', () => {
	const payload: Record<string, unknown> = { message: 'hello' }

	assert.equal(ensurePosition(payload, 'top'), true)
	assert.equal(payload.position, 'top')
})

test('ensurePosition ignores values that are not toast payloads', () => {
	assert.equal(ensurePosition('hello'), false)
	assert.equal(ensurePosition(null), false)
	assert.equal(ensurePosition(undefined), false)
	assert.equal(ensurePosition([{ content: 'hi' }]), false)

	const unrelated = { foo: 'bar' }
	assert.equal(ensurePosition(unrelated), false)
	assert.equal('position' in unrelated, false)
})

test('ensurePosition never throws on a frozen payload', () => {
	const payload = Object.freeze({ content: 'hello' }) as unknown as Record<string, unknown>

	assert.doesNotThrow(() => ensurePosition(payload))
	assert.equal(ensurePosition(payload), false)
})
