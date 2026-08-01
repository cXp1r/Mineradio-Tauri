import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	SONIC_DERIVED_SOURCE_PATHS,
	SONIC_ORIGIN_DOCUMENT_PATH,
	SONIC_ORIGIN_REQUIREMENTS,
	THIRD_PARTY_NOTICES_PATH,
	auditSonicOriginAttributionRecords,
	auditSonicOriginAttributionRepository,
} from "./sonic-origin-attribution.mjs";

function completeRecord(path: keyof typeof SONIC_ORIGIN_REQUIREMENTS) {
	return {
		path,
		content: SONIC_ORIGIN_REQUIREMENTS[path].join("\n"),
	};
}

function completeRecords() {
	return Object.keys(SONIC_ORIGIN_REQUIREMENTS).map((path) => (
		completeRecord(path as keyof typeof SONIC_ORIGIN_REQUIREMENTS)
	));
}

test("完整的 Sonic 来源链、作者、许可证、合作证据和维护者决策通过守卫", () => {
	expect(auditSonicOriginAttributionRecords(completeRecords())).toEqual([]);
});

test("每个直接衍生源码都必须保留来源、作者、许可证和修改声明", () => {
	expect(SONIC_DERIVED_SOURCE_PATHS.length).toBeGreaterThan(1);
	const missingPath = SONIC_DERIVED_SOURCE_PATHS[0];
	const violations = auditSonicOriginAttributionRecords(
		completeRecords().filter((record) => record.path !== missingPath),
	);

	expect(violations).toContainEqual({
		path: missingPath,
		kind: "missing-document",
		detail: missingPath,
	});
});

test("缺少来源决策文档时守卫失败", () => {
	const violations = auditSonicOriginAttributionRecords(
		completeRecords().filter((record) => record.path !== SONIC_ORIGIN_DOCUMENT_PATH),
	);

	expect(violations).toContainEqual({
		path: SONIC_ORIGIN_DOCUMENT_PATH,
		kind: "missing-document",
		detail: SONIC_ORIGIN_DOCUMENT_PATH,
	});
});

test("来源链、Ajin、许可证、公开合作证据或许可限定缺失时守卫失败", () => {
	const content = SONIC_ORIGIN_REQUIREMENTS[SONIC_ORIGIN_DOCUMENT_PATH]
		.filter((marker) => ![
			"3ff303e",
			"Non-Commercial Learning License",
			"公开合作证据",
			"不等于书面授权",
		].includes(marker))
		.join("\n")
		.replaceAll("Ajin", "");
	const records = completeRecords().map((record) => (
		record.path === SONIC_ORIGIN_DOCUMENT_PATH
			? { path: SONIC_ORIGIN_DOCUMENT_PATH, content }
			: record
	));

	expect(auditSonicOriginAttributionRecords(records)).toEqual([
		{ path: SONIC_ORIGIN_DOCUMENT_PATH, kind: "missing-attribution", detail: "3ff303e" },
		{ path: SONIC_ORIGIN_DOCUMENT_PATH, kind: "missing-attribution", detail: "Ajin" },
		{
			path: SONIC_ORIGIN_DOCUMENT_PATH,
			kind: "missing-attribution",
			detail: "Non-Commercial Learning License",
		},
		{
			path: SONIC_ORIGIN_DOCUMENT_PATH,
			kind: "missing-attribution",
			detail: "公开合作证据",
		},
		{
			path: SONIC_ORIGIN_DOCUMENT_PATH,
			kind: "missing-attribution",
			detail: "不等于书面授权",
		},
		{
			path: SONIC_ORIGIN_DOCUMENT_PATH,
			kind: "missing-attribution",
			detail: "与音域回响作者 Ajin 联动",
		},
	]);
});

test("第三方声明必须同步保留 Sonic 来源、非商业许可和许可限定", () => {
	const content = SONIC_ORIGIN_REQUIREMENTS[THIRD_PARTY_NOTICES_PATH]
		.filter((marker) => marker !== "个人非商业" && marker !== "不等于书面授权")
		.join("\n");
	const records = completeRecords().map((record) => (
		record.path === THIRD_PARTY_NOTICES_PATH
			? { path: THIRD_PARTY_NOTICES_PATH, content }
			: record
	));

	expect(auditSonicOriginAttributionRecords(records)).toEqual([
		{
			path: THIRD_PARTY_NOTICES_PATH,
			kind: "missing-attribution",
			detail: "不等于书面授权",
		},
		{
			path: THIRD_PARTY_NOTICES_PATH,
			kind: "missing-attribution",
			detail: "个人非商业",
		},
	]);
});

test("仓库中的 Sonic 来源和第三方声明满足可执行守卫", () => {
	expect(auditSonicOriginAttributionRepository()).toEqual([]);
	expect(
		existsSync(resolve(import.meta.dir, "../../docs/parity/sonic-clean-room-provenance.md")),
	).toBe(false);
});
