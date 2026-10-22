/**
 * The slice of the Vendetta/Revenge-legacy plugin API this plugin touches.
 *
 * Revenge legacy (and the Bunny/Pyon forks it descends from) evaluates a plugin
 * as `vendetta => { return <bundle> }`, so every one of these objects arrives as
 * a closure parameter instead of an import.
 */

export type AnyFunction = (...args: any[]) => any

export type LegacyModule = Record<string, any>

export interface LegacyMetro {
	common: {
		React: any
	}
	findByProps(...props: string[]): LegacyModule | undefined
	findByPropsAll(...props: string[]): LegacyModule[]
}

/** Patcher calls are `(key, parent, handler)` — the reverse of Revenge Next. */
export interface LegacyPatcher {
	instead(
		key: string,
		parent: any,
		handler: (this: any, args: any[], original: AnyFunction) => any,
	): () => boolean
	before(
		key: string,
		parent: any,
		handler: (this: any, args: any[]) => any[] | void,
	): () => boolean
}

export interface LegacyForms {
	FormSection: any
	FormRow: any
	FormSwitch: any
	FormDivider: any
}

export interface LegacyApi {
	metro: LegacyMetro
	patcher: LegacyPatcher
	storage: {
		useProxy<T>(storage: T): T
	}
	ui: {
		components: {
			Forms: LegacyForms
		}
	}
	logger: {
		log(...message: any[]): void
		warn(...message: any[]): void
		error(...message: any[]): void
	}
	plugin: {
		id: string
		manifest: Record<string, any>
		/** Persisted per-plugin storage (`createMMKVBackend(plugin.id)`). */
		storage: Record<string, any>
	}
}

export interface LegacyPlugin {
	onLoad(): void
	onUnload(): void
	settings: unknown
}
