import { memo, type ChangeEvent, type ReactElement } from "react";
import { SETTINGS_TABS, type SettingsTabId } from "./settings-catalog";
import type { SettingsTransactionSnapshot } from "./settings-transaction-controller";

export interface SettingsWorkbenchProps {
	activeTab: SettingsTabId;
	query: string;
	history: SettingsTransactionSnapshot;
	onTabChange(tab: SettingsTabId): void;
	onQueryChange(query: string): void;
	onUndo(): void;
	onRollbackTo(entryId: string): void;
	onEnableLowSpec(): void;
	onResetPreferences(): void;
}

export const SettingsWorkbench = memo(function SettingsWorkbench({
	activeTab,
	query,
	history,
	onTabChange,
	onQueryChange,
	onUndo,
	onRollbackTo,
	onEnableLowSpec,
	onResetPreferences,
}: SettingsWorkbenchProps): ReactElement {
	const recentEntries = [...history.entries.slice(-40)].reverse();
	const handleQuery = (event: ChangeEvent<HTMLInputElement>) => {
		onQueryChange(event.currentTarget.value);
	};

	return (
		<div className="settings-workbench" data-settings-workbench>
			<div className="settings-workbench-toolbar">
				<label className="settings-workbench-search">
					<span aria-hidden="true">⌕</span>
					<input
						type="search"
						aria-label="搜索设置"
						placeholder="搜索设置"
						value={query}
						onChange={handleQuery}
					/>
				</label>
				<button
					className="settings-workbench-action"
					type="button"
					onClick={onEnableLowSpec}
					disabled={history.busy}
				>
					低配模式
				</button>
				<button
					className="settings-workbench-action"
					type="button"
					data-settings-reset
					onClick={onResetPreferences}
					disabled={history.busy}
				>
					重置全部
				</button>
				<button
					className="settings-workbench-action"
					type="button"
					data-settings-undo
					onClick={onUndo}
					disabled={history.busy || !history.entries.length}
				>
					撤销
				</button>
			</div>
			<div className="settings-workbench-tabs" role="tablist" aria-label="设置分类">
				{SETTINGS_TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						data-settings-tab={tab.id}
						aria-selected={activeTab === tab.id}
						className={activeTab === tab.id ? "active" : ""}
						title={tab.description}
						onClick={() => onTabChange(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>
			{history.error ? (
				<div className="settings-workbench-error" role="status">
					{history.error}
				</div>
			) : null}
			<div className="settings-workbench-history" aria-label="最近更改">
				<div className="settings-workbench-history-head">
					<span>最近更改</span>
					<small>{history.entries.length}/40</small>
				</div>
				{recentEntries.length ? (
					<div className="settings-workbench-history-list">
						{recentEntries.map((entry) => (
							<button
								key={entry.id}
								type="button"
								data-settings-rollback={entry.id}
								disabled={history.busy}
								onClick={() => onRollbackTo(entry.id)}
								title="回滚到此更改之前"
							>
								<span>{entry.label}</span>
								<small>{entry.changedPaths.length} 项</small>
							</button>
						))}
					</div>
				) : (
					<div className="settings-workbench-history-empty">本次启动还没有可撤销更改</div>
				)}
			</div>
		</div>
	);
});
