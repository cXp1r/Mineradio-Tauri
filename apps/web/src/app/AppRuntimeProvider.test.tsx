import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AppServices } from "./app-services";
import {
	AppRuntimeProvider,
	useAppServices,
} from "./AppRuntimeProvider";

test("AppRuntimeProvider exposes the exact injected services", () => {
	const services = { marker: "services" } as unknown as AppServices;
	let observed: AppServices | null = null;
	function Probe() {
		observed = useAppServices();
		return <span>probe</span>;
	}

	renderToString(
		<AppRuntimeProvider services={services}>
			<Probe />
		</AppRuntimeProvider>,
	);

	expect(observed).toBe(services);
});

test("useAppServices rejects consumers outside AppRuntimeProvider", () => {
	function Probe() {
		useAppServices();
		return <span>probe</span>;
	}
	let message = "";
	try {
		renderToString(<Probe />);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toBe("useAppServices 必须在 AppRuntimeProvider 内使用");
});
