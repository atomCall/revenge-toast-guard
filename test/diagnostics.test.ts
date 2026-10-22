import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createInspector,
	describeModule,
	describeValue,
	findComponentExports,
} from '../src/diagnostics.ts'

test('describeValue names primitives, including the ones JSON drops', () => {
	assert.equal(describeValue(undefined), 'undefined')
	assert.equal(describeValue(null), 'null')
	assert.equal(describeValue(3), '3')
	assert.equal(describeValue(true), 'true')
	assert.equal(describeValue('hi'), '"hi"')
})

test('describeValue shows a function by name, since Hermes keeps names', () => {
	assert.equal(describeValue(function ToastContainer() {}), 'fn:ToastContainer')
	assert.equal(describeValue(() => undefined), 'fn')
})

test('describeValue spells out an object with its keys and their types', () => {
	assert.equal(describeValue({ toasts: undefined, handlers: {} }), '{toasts:undefined,handlers:{}}')
})

test('describeValue reports array length, entries and holes', () => {
	const withHole = [{ id: 'a' }, , undefined]

	assert.equal(describeValue(withHole), 'array(3)[{id:"a"},<hole>,undefined]')
	assert.equal(describeValue([]), 'array(0)[]')
})

test('describeValue caps long arrays and long objects', () => {
	assert.equal(describeValue([1, 2, 3, 4]), 'array(4)[1,2,3,…]')

	const wide: Record<string, unknown> = {}
	for (let index = 0; index < 30; index++) wide[`k${index}`] = index

	const described = describeValue(wide)
	assert.match(described, /…\+6\}$/)
	assert.ok(described.length < 500)
})

test('describeValue truncates long strings and flattens newlines', () => {
	assert.equal(describeValue('a\nb'), '"a b"')
	assert.match(describeValue('x'.repeat(100)), /^"x{32}…"$/)
})

test('describeValue stops at a cycle instead of recursing forever', () => {
	const state: Record<string, unknown> = { toasts: [] }
	state.self = state

	assert.match(describeValue(state), /self:<cycle>/)
})

test('describeValue stops at the depth limit', () => {
	assert.equal(describeValue({ a: { b: { c: 1 } } }), '{a:{b:{c:1}}}')
	assert.equal(describeValue({ a: { b: { c: { d: 1 } } } }), '{a:{b:{c:{…}}}}')
})

test('describeModule lists sibling exports with their kinds', () => {
	const module = {
		default: function ToastContainer() {},
		useToastContainer: () => undefined,
		ToastStore: {},
	}

	assert.equal(
		describeModule(module),
		'{default:fn:ToastContainer,useToastContainer:fn:useToastContainer,ToastStore:{}}',
	)
})

test('findComponentExports matches on the function name', () => {
	const module = {
		default: function ToastContainer() {},
		ToastContainer: function ToastContainer() {},
		other: function Other() {},
	}

	assert.deepEqual(findComponentExports(module, 'ToastContainer'), ['default', 'ToastContainer'])
	assert.deepEqual(findComponentExports(undefined, 'ToastContainer'), [])
})

test('createInspector logs one line per distinct shape and remembers the last', () => {
	const lines: string[] = []
	const inspector = createInspector(line => lines.push(line))

	inspector.observe({ toasts: [] }, 1)
	inspector.observe({ toasts: [] }, 2)
	inspector.observe({ toasts: [{ id: 'a' }] }, 3)

	assert.deepEqual(lines, [
		'hook result #1 (render 1): {toasts:array(0)[]}',
		'hook result #2 (render 3): {toasts:array(1)[{id:"a"}]}',
	])
	assert.equal(inspector.last, '{toasts:array(1)[{id:"a"}]}')
	assert.equal(inspector.shapes, 2)
})

test('createInspector stops describing after the cap but keeps the last shape', () => {
	const lines: string[] = []
	const inspector = createInspector(line => lines.push(line), 2)

	inspector.observe({ a: 1 }, 1)
	inspector.observe({ b: 2 }, 2)
	inspector.observe({ c: 3 }, 3)

	assert.equal(lines.length, 2)
	assert.equal(inspector.last, '{b:2}')
})

test('createInspector survives a state it cannot describe', () => {
	const lines: string[] = []
	const inspector = createInspector(line => lines.push(line))
	const hostile = new Proxy(
		{},
		{
			ownKeys() {
				throw new Error('nope')
			},
		},
	)

	assert.doesNotThrow(() => inspector.observe(hostile, 1))
	assert.equal(lines.length, 0)
	assert.equal(inspector.last, 'unknown')
})
