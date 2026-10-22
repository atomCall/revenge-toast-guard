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
	const React = api.metro.common.React
	const { Forms } = api.ui.components

	const read = (key: keyof Settings): boolean => storage[key] ?? DEFAULT_SETTINGS[key]
	const write = (key: keyof Settings) => (value: boolean) => {
		storage[key] = value
	}

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

	return function ToastGuardSettings() {
		// Subscribes to storage writes so toggling a switch re-renders the page
		api.storage.useProxy(storage)

		return React.createElement(
			Forms.FormSection,
			{ title: 'Toast Guard' },
			row(
				'sanitizeContainer',
				'Guard the toast container',
				'Drops malformed toasts instead of crashing the screen that renders them.',
			),
			row(
				'sanitizeDispatcher',
				'Fix toasts at the source',
				'Gives a missing position to toasts before Discord enqueues them.',
			),
			row(
				'logDiagnostics',
				'Log dropped toasts',
				'Writes what was fixed or dropped to the React Native log.',
			),
		)
	}
}
