import type { ComponentProps } from 'react'
import Page from '@revenge-mod/components/Page'
import TableRowAssetIcon from '@revenge-mod/components/TableRowAssetIcon'
import { Design } from '@revenge-mod/discord/design'
import type { PluginSettingsComponent } from '@revenge-mod/plugins/types'
import { DEFAULT_SETTINGS, type Settings } from './config'

const { TableRowGroup, TableSwitchRow } = Design

type Props = ComponentProps<PluginSettingsComponent<{ jsonStorage: Settings }>>

export default function SettingsComponent({ api: { jsonStorage: storage } }: Props) {
	const settings = storage.use() ?? DEFAULT_SETTINGS

	return (
		<Page>
			<TableRowGroup title="Protection">
				<TableSwitchRow
					label="Guard the toast container"
					subLabel="Drops malformed toasts instead of crashing the screen that renders them."
					icon={<TableRowAssetIcon name="EyeSlashIcon" />}
					value={settings.sanitizeContainer}
					onValueChange={(value: boolean) => storage.set({ sanitizeContainer: value })}
				/>
				<TableSwitchRow
					label="Fix toasts at the source"
					subLabel="Gives a missing position to toasts before Discord enqueues them."
					icon={<TableRowAssetIcon name="DenyIcon" />}
					value={settings.sanitizeDispatcher}
					onValueChange={(value: boolean) => storage.set({ sanitizeDispatcher: value })}
				/>
			</TableRowGroup>

			<TableRowGroup title="Diagnostics">
				<TableSwitchRow
					label="Log dropped toasts"
					subLabel="Writes what was fixed or dropped to the React Native log."
					icon={<TableRowAssetIcon name="ArrowAngleLeftUpIcon" />}
					value={settings.logDiagnostics}
					onValueChange={(value: boolean) => storage.set({ logDiagnostics: value })}
				/>
			</TableRowGroup>
		</Page>
	)
}
