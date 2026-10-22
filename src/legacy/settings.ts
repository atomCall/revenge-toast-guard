import { DEFAULT_SETTINGS, type Settings } from '../config'
import type { LegacyApi } from './types'

/**
 * Revenge legacy renders a plugin's `settings` component without props, so the
 * storage proxy and the host React are closed over instead.
 *
 * `useProxy` is the legacy subscription primitive: it re-renders this component
 * every time the storage proxy emits a `SET`/`DEL` event.
 */
export default function createSettings(api: LegacyApi, storage: Partial<Settings>) {
	const read = (key: keyof Settings): boolean => storage[key] ?? DEFAULT_SETTINGS[key]
	const write = (key: keyof Settings) => (value: boolean) => {
		storage[key] = value
	}

	return function ToastGuardSettings() {
		// Resolved at render time: `metro.common.React` and `Forms` are lazy
		// lookups, and the loader builds this component before Discord settles.
		const React = api.metro.common.React
		const { Forms } = api.ui.components

		// Subscribes to storage writes so toggling a switch re-renders the page
		api.storage.useProxy(storage)

		const row = (key: keyof Settings, label: string, subLabel: string) =>
			React.createElement(Forms.FormRow, {
				key,
				label,
				subLabel,
				trailing: React.createElement(Forms.FormSwitch, {
					value: read(key),
					onValueChange: write(key),
				}),
			})

		return React.createElement(
			Forms.FormSection,
			{ title: 'Toast Guard' },
			row(
				'sanitizeContainer',
				'Guard the toast container',
				'Repairs malformed toasts in place instead of crashing the screen that renders them.',
			),
			row(
				'sanitizeDispatcher',
				'Fix toasts at the source',
				'Gives a missing position to toasts before Discord enqueues them.',
			),
			row(
				'logDiagnostics',
				'Log repaired toasts',
				'Writes what was repaired or replaced to the React Native log.',
			),
		)
	}
}

