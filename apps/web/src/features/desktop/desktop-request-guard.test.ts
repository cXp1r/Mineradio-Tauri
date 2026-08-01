import { expect, test } from "bun:test";
import {
	createDesktopRequestGuard,
	runLatestDesktopRequest,
} from "./desktop-request-guard";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("latest desktop request wins when an older response finishes last", async () => {
	const guard = createDesktopRequestGuard();
	const first = deferred<string>();
	const second = deferred<string>();
	const commits: string[] = [];

	const oldRequest = runLatestDesktopRequest(guard, () => first.promise, (value) => {
		commits.push(value);
	});
	const newRequest = runLatestDesktopRequest(guard, () => second.promise, (value) => {
		commits.push(value);
	});

	second.resolve("new");
	await newRequest;
	first.resolve("old");
	await oldRequest;

	expect(commits).toEqual(["new"]);
});

test("disposed desktop request guard rejects pending success and error commits", async () => {
	const successGuard = createDesktopRequestGuard();
	const success = deferred<string>();
	const commits: string[] = [];
	const errors: string[] = [];
	const successRequest = runLatestDesktopRequest(
		successGuard,
		() => success.promise,
		(value) => commits.push(value),
		(error) => errors.push(String(error)),
	);
	successGuard.dispose();
	success.resolve("late");
	await successRequest;

	const errorGuard = createDesktopRequestGuard();
	const errorRequest = runLatestDesktopRequest(
		errorGuard,
		async () => {
			throw new Error("late failure");
		},
		(value) => commits.push(value),
		(error) => errors.push(String(error)),
	);
	errorGuard.dispose();
	await errorRequest;

	expect(commits).toEqual([]);
	expect(errors).toEqual([]);
});
