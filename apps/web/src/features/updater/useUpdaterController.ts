import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateStore } from "../../stores/update-store";
import {
	checkForUpdate,
	getUpdaterStatus,
	installUpdate,
	shouldOpenDevUpdatePreview,
	type UpdateCheckResult,
} from "../../tauri/updater";

export interface UpdaterControllerDependencies {
	checkForUpdate(): Promise<UpdateCheckResult>;
	getUpdaterStatus(): Promise<UpdateCheckResult>;
	installUpdate(): Promise<UpdateCheckResult>;
	shouldOpenDevUpdatePreview(): boolean;
}

export interface UpdaterControllerResult {
	modalOpen: boolean;
	setModalOpen(open: boolean): void;
	refresh(manual?: boolean): Promise<void>;
	install(): Promise<void>;
}

const defaultDependencies: UpdaterControllerDependencies = {
	checkForUpdate,
	getUpdaterStatus,
	installUpdate,
	shouldOpenDevUpdatePreview,
};

export function useUpdaterController({
	showToast,
	dependencies = defaultDependencies,
}: {
	showToast(message: string): void;
	dependencies?: UpdaterControllerDependencies;
}): UpdaterControllerResult {
	const [modalOpen, setModalOpen] = useState(false);
	const applyCheckResult = useUpdateStore((state) => state.applyCheckResult);
	const setUpdateStatus = useUpdateStore((state) => state.setStatus);
	const dependenciesRef = useRef({ dependencies, showToast });
	dependenciesRef.current = { dependencies, showToast };

	const refresh = useCallback(async (manual = false) => {
		const current = dependenciesRef.current;
		try {
			if (manual) setUpdateStatus("checking");
			const result = manual
				? await current.dependencies.checkForUpdate()
				: await current.dependencies.getUpdaterStatus();
			applyCheckResult(result);
			if (!manual) return;
			if (result.error) current.showToast(result.message || result.error);
			else if (result.available) {
				current.showToast(
					result.signatureGate
						? "发现新版本，签名密钥未配置"
						: `发现新版本 v${result.version ?? ""}`,
				);
			} else current.showToast("当前已是最新版本");
		} catch (error) {
			setUpdateStatus("error");
			current.showToast(error instanceof Error ? error.message : "更新检测失败");
		}
	}, [applyCheckResult, setUpdateStatus]);

	const install = useCallback(async () => {
		const current = dependenciesRef.current;
		try {
			setUpdateStatus("downloading");
			current.showToast("开始下载更新");
			setUpdateStatus("installing");
			const result = await current.dependencies.installUpdate();
			applyCheckResult(result);
			if (result.error) {
				setUpdateStatus("error");
				current.showToast(result.message || result.error);
				return;
			}
			current.showToast("更新安装程序已启动");
		} catch (error) {
			setUpdateStatus("error");
			current.showToast(error instanceof Error ? error.message : "更新安装失败");
		}
	}, [applyCheckResult, setUpdateStatus]);

	useEffect(() => {
		void refresh(false);
		if (dependenciesRef.current.dependencies.shouldOpenDevUpdatePreview()) {
			setModalOpen(true);
		}
	}, [refresh]);

	return { modalOpen, setModalOpen, refresh, install };
}
