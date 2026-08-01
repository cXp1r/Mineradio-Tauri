import { useLayoutEffect, useSyncExternalStore } from "react";
import type { UpdateReceipt } from "../../ports/update-runtime-port";
import type { UpdateExperienceController } from "./update-experience-controller";
import type {
	UpdatePresentationMode,
	UpdateViewModel,
} from "./update-view-model";

export interface UpdateExperience {
	readonly viewModel: UpdateViewModel;
	openModal(): void;
	closeModal(): void;
	checkNow(): Promise<UpdateReceipt>;
	invokePrimary(): Promise<UpdateReceipt>;
	remindLater(): Promise<UpdateReceipt>;
	skipVersion(): Promise<UpdateReceipt>;
	openRelease(): Promise<UpdateReceipt>;
}

/**
 * React 只订阅长寿命 controller 的只读投影，不复制 native phase。
 * controller 的创建和释放属于应用 bootstrap，不能跟随 StrictMode mount 生命周期。
 */
export function useUpdateExperience(
	controller: UpdateExperienceController,
	presentation: UpdatePresentationMode,
): UpdateExperience {
	const viewModel = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);

	// 沉浸态必须在浏览器绘制前压制 modal，避免先显示一帧再由普通 effect 关闭。
	useLayoutEffect(() => {
		controller.setPresentation(presentation);
	}, [controller, presentation]);

	return {
		viewModel,
		openModal: controller.openModal,
		closeModal: controller.closeModal,
		checkNow: controller.checkNow,
		invokePrimary: () => controller.invokePrimary(viewModel.primaryIntent),
		remindLater: () => controller.remindLater(viewModel.candidate?.id ?? null),
		skipVersion: () => controller.skipVersion(viewModel.candidate?.id ?? null),
		openRelease: () => controller.openRelease(viewModel.candidate?.id ?? null),
	};
}
