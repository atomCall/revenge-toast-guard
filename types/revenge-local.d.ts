/**
 * Minimal local declarations for the Revenge Next runtime.
 *
 * They exist so `tsc --noEmit` works offline. The canonical types are shipped by
 * `@revenge-mod/types` (see the Revenge plugin template); when that package is
 * installed, delete this file so the real declarations take over.
 */

interface JsonStorage<S> {
	cache?: S
	get(): S
	set(patch: Partial<S>): void
	use(): S | undefined
	subscribe(listener: (value: S, mode: number) => void): () => void
}

interface PluginRuntimeApi<T> {
	cleanup(...fns: unknown[]): void
	jsonStorage: JsonStorage<T extends { jsonStorage: infer S } ? S : Record<string, unknown>>
	plugin: {
		startedLate?: boolean
		requireReload(): void
		reportError(error: unknown): void
	}
}

declare function plugin<T = Record<string, never>>(options: {
	jsonStorage?: {
		load?: boolean
		default?: T extends { jsonStorage: infer S } ? S : never
	}
	preInit?: (api: PluginRuntimeApi<T>) => void
	init?: (api: PluginRuntimeApi<T>) => void
	start?: (api: PluginRuntimeApi<T>) => void
	stop?: (api: PluginRuntimeApi<T>) => void
	SettingsComponent?: unknown
}): unknown

declare module '@revenge-mod/modules/finders' {
	export function getModules(
		filter: unknown,
		callback: (module: any) => void,
		options?: { max?: number },
	): () => void
	export function findModule(filter: unknown): any
}

declare module '@revenge-mod/modules/finders/filters' {
	export function withProps(...props: string[]): unknown
	export function withName(name: string): unknown
	export function withPropsAndName(name: string, ...props: string[]): unknown
}

declare module '@revenge-mod/patcher' {
	export type UnpatchFunction = () => void
	export function instead(
		parent: any,
		key: string,
		hook: (this: any, args: any[], original: (...args: any[]) => any) => any,
	): UnpatchFunction
	export function before(
		parent: any,
		key: string,
		hook: (this: any, args: any[]) => any[] | void,
	): UnpatchFunction
	export function after(
		parent: any,
		key: string,
		hook: (this: any, result: any, args: any[]) => any,
	): UnpatchFunction
}

declare module '@revenge-mod/plugins/types' {
	import type { ReactNode } from 'react'

	export type PluginSettingsComponent<T> = (props: {
		api: {
			jsonStorage: JsonStorage<
				T extends { jsonStorage: infer S } ? S : Record<string, unknown>
			>
			cleanup: (...fns: unknown[]) => void
		}
	}) => ReactNode
}

declare module '@revenge-mod/discord/design' {
	export const Design: any
}

declare module '@revenge-mod/components/Page' {
	const Page: any
	export default Page
}

declare module '@revenge-mod/components/TableRowAssetIcon' {
	const TableRowAssetIcon: any
	export default TableRowAssetIcon
}
