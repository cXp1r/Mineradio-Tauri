# Mineradio M1 Account Session Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保持现有 AccountPort、Cookie、登录状态、登出、歌单/Home 同步和中文提示行为不变，把三平台会话状态与动作从 `App.tsx` 提取到独立 accounts controller。

**Architecture:** 新建 `useAccountSessionController` 持有 `statusByProvider`，通过现有 `AccountPort` 执行 status、Cookie 和 logout。App 继续拥有 textarea ref、手动导入面板、modal 和账户下拉，只把输入值与 UI lifecycle callbacks 传给 controller；二维码 runtime 和 `SidecarRecoveryRuntime` 通过 controller 的 `acceptProviderStatus` 汇合状态。

**Tech Stack:** TypeScript 5.9、React 19、Bun test、现有 `AccountPort`、`@mineradio/shared` session DTO。

---

## Invariants

- Sidecar routes、DTO、错误、Cookie 格式、`ProviderId`、supervisor 和 packaging 不变；
- controller 只依赖 `AccountPort`，不得导入 `SidecarClient`；
- status refresh：登录时只同步该 Provider 歌单，未登录时刷新完整资料库，并保持现有 toast；
- Cookie 为空或 AccountPort 未连接时不清空输入；真正发起导入后无论成功失败都清空输入；成功写入 session 后立即关闭手动导入面板；
- Cookie 登录成功后同步 Provider 歌单和 Home；同步失败先显示“已登录，歌单同步失败”，再保持原有最终登录 toast；
- logout 成功后发布 `{ provider, loggedIn: false }`、刷新完整资料库并显示会话已清除；失败不修改状态；
- modal、账户下拉、二维码 runtime 和输入 DOM ref 不迁入本 controller；
- TDD 仅覆盖 Cookie 导入和 logout 核心流程；status/UI 接线使用现有 App characterization 与边界测试。

### Task 1: Add the tested account session controller

**Files:**
- Create: `apps/web/src/features/accounts/useAccountSessionController.ts`
- Create: `apps/web/src/features/accounts/useAccountSessionController.test.tsx`

- [x] **Step 1: Write the failing Cookie import tracer test**

最小 React harness 注入 fake `AccountPort`，调用：

```ts
await controller.importProviderCookie("qq", "uin=1", {
	onStored: () => events.push("stored"),
	onFinished: () => events.push("finished"),
});
```

断言事件顺序为：

```ts
[
	"set-session",
	"stored",
	"login-status",
	"sync-provider",
	"toast:QQ 音乐已登录: 10001",
	"finished",
]
```

并在 promise 完成后的下一次 React commit 断言 `statusByProvider.qq` 已更新为登录状态。

- [x] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/accounts/useAccountSessionController.test.tsx
```

Expected: FAIL because the controller module does not exist.

- [x] **Step 3: Implement the controller public interface**

```ts
export interface AccountSessionControllerResult {
	statusByProvider: Record<LoginProviderId, ProviderLoginStatus | null>;
	acceptProviderStatus(status: ProviderLoginStatus): void;
	refreshProviderStatus(provider: LoginProviderId): Promise<void>;
	importProviderCookie(
		provider: LoginProviderId,
		cookie: string,
		lifecycle?: {
			onStored?(): void;
			onFinished?(): void;
		},
	): Promise<void>;
	logoutProvider(provider: LoginProviderId): Promise<void>;
}
```

依赖为 `AccountPort | null`、`syncProviderPlaylists`、`refreshHome`、`refreshLibrary`、`providerLabel` 和 `showToast`。status refresh 只调用 `syncProviderPlaylists`；Cookie 登录成功依次调用 `syncProviderPlaylists` 与 `refreshHome`，保持当前行为差异。使用 callback ref 保持 action identity，不把 view callback identity 变成 action 重建条件。

- [x] **Step 4: Add the logout core test**

逐个 RED→GREEN 断言：

```ts
await controller.logoutProvider("soda");
```

按顺序调用 `accounts.logout`、发布 logged-out status、刷新完整资料库并显示 `汽水音乐会话已清除`；logout reject 时保留旧状态并显示原错误。

- [x] **Step 5: Run focused verification and commit**

```powershell
bun test apps/web/src/features/accounts
bun run --filter ./apps/web typecheck
git add apps/web/src/features/accounts docs/superpowers/plans/2026-07-26-m1-account-session-controller.md
git commit -m "refactor(web): add account session controller"
```

### Task 2: Integrate App session ownership

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Create: `scripts/architecture/account-session-boundary.test.ts`

- [ ] **Step 1: Replace App-owned provider status state**

删除三组 `neteaseStatus`、`qqStatus`、`sodaStatus` state，以及 App 内的 `setProviderStatus`、`refreshProviderStatus`、Cookie 业务流程和 logout 业务流程。App 从 controller 读取 `statusByProvider`，并派生现有三个局部 status 变量以保持 JSX 变化最小。

- [ ] **Step 2: Preserve textarea and modal lifecycle in App**

App 保留薄 wrapper：

```ts
const importProviderCookie = useCallback(async (provider: LoginProviderId) => {
	const input = provider === "netease"
		? neteaseCookieInputRef.current
		: provider === "soda"
			? sodaCookieInputRef.current
			: qqCookieInputRef.current;
	await importSessionCookie(provider, input?.value.trim() ?? "", {
		onStored: () => setQqManualCookieOpen(false),
		onFinished: () => {
			if (input) input.value = "";
		},
	});
}, [importSessionCookie]);
```

`useLoginQrRuntime.onProviderStatus` 和 `SidecarRecoveryRuntime.onProviderStatus` 改为 `acceptProviderStatus`。

- [ ] **Step 3: Add the architecture guard**

断言 App 不再包含：

```text
setNeteaseStatus
setQqStatus
setSodaStatus
setProviderSessionCookie(
.loginStatus(provider)
.logout(provider)
```

并断言 App 使用 `useAccountSessionController({`，controller 依赖 `AccountPort` 且不导入 `SidecarClient`。

- [ ] **Step 4: Run characterization and build**

```powershell
bun test apps/web/src/features/accounts apps/web/src/app/App.test.tsx scripts/architecture/account-session-boundary.test.ts
bun run --filter ./apps/web typecheck
bun run web:build
```

- [ ] **Step 5: Commit integration**

```powershell
git add apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx scripts/architecture/account-session-boundary.test.ts docs/superpowers/plans/2026-07-26-m1-account-session-controller.md
git commit -m "refactor(web): move account sessions out of App"
```

### Task 3: Record evidence and audit frozen API

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-account-session-controller.md`

- [ ] **Step 1: Record session controller ownership**

记录 status、Cookie 和 logout 已迁移；账户 modal、dropdown、资料库/Home controller 仍未提取，`accounts.multi-provider` 继续保持 `baseline`。

- [ ] **Step 2: Run full verification**

```powershell
bun run typecheck
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run web:build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
node scripts/architecture/verify-convergence-baseline.mjs
git diff --check
git diff --exit-code d33dc6e..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

- [ ] **Step 3: Commit evidence**

```powershell
git add docs/parity docs/superpowers/plans/2026-07-26-m1-account-session-controller.md
git commit -m "docs: record account session extraction"
```

## Completion checkpoint

- `App.tsx` 不再持有 Provider status state 或 AccountPort 会话业务；
- QR、bootstrap recovery、Cookie、refresh 和 logout 汇合到同一 status map；
- Cookie textarea、modal 和 dropdown DOM 行为保持；
- frozen API diff 为空。
