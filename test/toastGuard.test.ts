import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createSafeToastState,
	DEFAULT_POSITION,
	ensurePosition,
	guardToastState,
	inferDefaultPosition,
	normalizeHandlers,
	normalizeToastState,
	sanitizeToast,
	sanitizeToasts,
} from '../src/toastGuard.ts'

test('sanitizeToast keeps an already valid toast untouched', () => {
	const toast = { id: 'a', position: 'bottom', content: 'hi' }
	const result = sanitizeToast(toast)

	assert.equal(result.ok, true)
	assert.equal(result.ok && result.toast, toast)
})

test('sanitizeToast fills a missing position with the default', () => {
	const result = sanitizeToast({ id: 'a', content: 'hi' })

	assert.equal(result.ok, true)
	assert.equal(result.ok && result.toast.position, DEFAULT_POSITION)
	assert.equal(result.ok && result.toast.content, 'hi')
})

test('sanitizeToast fills an empty position', () => {
	const result = sanitizeToast({ id: 'a', position: '' })

	assert.equal(result.ok, true)
	assert.equal(result.ok && result.toast.position, DEFAULT_POSITION)
})

test('sanitizeToast keeps non-string positions that are not empty', () => {
	const result = sanitizeToast({ id: 'a', position: 3 })

	assert.equal(result.ok, true)
	assert.equal(result.ok && result.toast.position, 3)
})

test('sanitizeToast rejects values that are not objects', () => {
	for (const value of [undefined, null, 42, 'toast', true]) {
		const result = sanitizeToast(value)

		assert.equal(result.ok, false)
		assert.equal(result.ok === false && result.reason, 'not-an-object')
	}
})

test('sanitizeToast rejects entries without a usable id', () => {
	for (const value of [{}, { id: '' }, { id: null }, { id: Number.NaN }]) {
		const result = sanitizeToast(value)

		assert.equal(result.ok, false)
		assert.equal(result.ok === false && result.reason, 'missing-id')
	}
})

test('sanitizeToast accepts numeric ids', () => {
	const result = sanitizeToast({ id: 7 })

	assert.equal(result.ok, true)
	assert.equal(result.ok && result.toast.id, 7)
})

test('sanitizeToasts drops the undefined entries that cause the crash', () => {
	const input = [{ id: 'a', position: 'top' }, undefined, null, { id: 'b' }]
	const invalid: unknown[] = []

	const toasts = sanitizeToasts(input, {
		onInvalid: (_reason, entry) => invalid.push(entry),
	})

	assert.deepEqual(
		toasts.map(toast => toast.id),
		['a', 'b'],
	)
	assert.equal(invalid.length, 2)
	// `{ id: 'b' }` inherits the position of the valid sibling instead of guessing one
	assert.equal(toasts[1].position, 'top')
})

test('sanitizeToasts returns an empty list for non-array input', () => {
	const reasons: string[] = []

	assert.deepEqual(sanitizeToasts(undefined, { onInvalid: reason => reasons.push(reason) }), [])
	assert.deepEqual(sanitizeToasts({ 0: { id: 'a' } }, { onInvalid: reason => reasons.push(reason) }), [])
	assert.deepEqual(reasons, ['not-an-array', 'not-an-array'])
})

test('sanitizeToasts keeps the last entry for a duplicated id', () => {
	const first = { id: 'a', position: 'top', content: 'old' }
	const last = { id: 'a', position: 'bottom', content: 'new' }

	const toasts = sanitizeToasts([first, { id: 'b' }, last])

	assert.deepEqual(
		toasts.map(toast => toast.id),
		['b', 'a'],
	)
	assert.equal(toasts[1], last)
})

test('sanitizeToasts does not mutate its input', () => {
	const input = [{ id: 'a' }, { id: 'b', position: 'top' }]
	const snapshot = structuredClone(input)

	sanitizeToasts(input)

	assert.deepEqual(input, snapshot)
	assert.notEqual(sanitizeToasts(input)[0], input[0])
})

test('sanitizeToasts inherits the position of a valid sibling when no default is given', () => {
	const toasts = sanitizeToasts([{ id: 'a', position: 'bottom' }, { id: 'b' }])

	assert.equal(toasts[1].position, 'bottom')
})

test('sanitizeToasts respects an explicit default over the siblings', () => {
	const toasts = sanitizeToasts([{ id: 'a', position: 'bottom' }, { id: 'b' }], {
		defaultPosition: 'top',
	})

	assert.equal(toasts[1].position, 'top')
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

test('normalizeToastState preserves extra state fields and sanitizes toasts', () => {
	const state = normalizeToastState({
		toasts: [{ id: 'a' }, undefined],
		handlers: { calculateOffset: () => 5 },
		pausedAt: 123,
	})

	assert.equal(state.pausedAt, 123)
	assert.equal(state.toasts.length, 1)
	assert.equal(state.handlers.calculateOffset(), 5)
	assert.equal(typeof state.handlers.endPause, 'function')
})

test('normalizeToastState leaves an unexpected shape alone', () => {
	const tuple = [{ id: 'a', position: 'top' }, { dismiss: () => {} }]

	assert.equal(normalizeToastState(tuple), tuple)
})

test('guardToastState returns the normalized state of a healthy hook', () => {
	let errors = 0
	const state = guardToastState(() => ({ toasts: [{ id: 'a', position: 'top' }] }), {
		onError: () => errors++,
	})

	assert.equal(errors, 0)
	assert.equal(state.toasts.length, 1)
	assert.equal(typeof state.handlers.calculateOffset, 'function')
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

test('guardToastState swallows the crash and reports it', () => {
	const crash = new TypeError("Cannot read property 'position' of undefined")
	let reported: unknown
	let state: ReturnType<typeof guardToastState> | undefined

	assert.doesNotThrow(() => {
		state = guardToastState(
			() => {
				throw crash
			},
			{ onError: error => (reported = error) },
		)
	})

	assert.equal(reported, crash)
	assert.deepEqual(state!.toasts, [])
})

test('guardToastState falls back to the last known good state', () => {
	const fallback = normalizeToastState({ toasts: [{ id: 'a', position: 'top' }] })
	const state = guardToastState(
		() => {
			throw new Error('boom')
		},
		{ fallback },
	)

	assert.equal(state, fallback)
	assert.equal(state.toasts.length, 1)
})

test('guardToastState tolerates hooks returning nothing usable', () => {
	for (const value of [undefined, null, 'nope', 0]) {
		const state = guardToastState(() => value)

		assert.deepEqual(state.toasts, [])
		assert.equal(state.handlers.calculateOffset(), 0)
	}
})

test('guardToastState does not throw when onError throws', () => {
	const state = guardToastState(
		() => {
			throw new Error('boom')
		},
		{
			onError: () => {
				throw new Error('reporting failed')
			},
		},
	)

	assert.deepEqual(state.toasts, [])
})
