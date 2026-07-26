# Mineradio M1 Account QR Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保持现有登录 API、二维码文案和同步行为不变，把网易云、QQ、汽水的二维码生成、轮询与 cleanup 从 `App.tsx` 提取到独立 accounts runtime。

**Architecture:** 使用无 React 依赖的 `LoginQrCoordinator` 管理 generation token、轮询 in-flight lease 和结果分类；使用 `useLoginQrRuntime` 通过既有 `AccountPort` 执行二维码生成与检查。App 继续拥有 modal、Cookie 输入、账户下拉和资料库数据，只注入登录成功后的歌单/Home 同步回调。

**Tech Stack:** TypeScript 5.9、React 19、Bun test、现有 `AccountPort`、`@mineradio/shared` session DTO。

---

## Invariants

- Sidecar HTTP routes、DTO、错误结构、`ProviderId`、supervisor 和 packaging 不变；
- 继续支持 `netease`、`qq`、`soda` 三个平台，二维码轮询间隔保持 1800ms；
- 打开 full/single-provider modal 时立即生成二维码，add-account 模式不生成；
- 每个二维码开始轮询时立即检查一次，后续 interval 不得并发重入；
- refresh、provider 切换、modal 关闭或 unmount 后，旧二维码图片、检查结果、login status 和同步结果不得提交；
- `stored || loggedIn`、过期 code `800/65`、扫码 code `802/67` 的兼容判断不变；
- 成功后的状态文案、歌单/Home 同步、失败降级与 toast 文案不变；
- Cookie 导入、logout、账户下拉和 provider status 手动刷新不属于本批。

### Task 1: Add the tested QR coordinator

**Files:**
- Create: `apps/web/src/features/accounts/login-qr-coordinator.ts`
- Create: `apps/web/src/features/accounts/login-qr-coordinator.test.ts`

- [x] **Step 1: Write the failing stale-generation test**

```ts
const coordinator = new LoginQrCoordinator();
const first = coordinator.beginGeneration();
const second = coordinator.beginGeneration();
expect(coordinator.isGenerationCurrent(first)).toBe(false);
expect(coordinator.isGenerationCurrent(second)).toBe(true);
```

- [x] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/accounts/login-qr-coordinator.test.ts
```

Expected: FAIL because the coordinator module does not exist.

- [x] **Step 3: Implement generation ownership and verify GREEN**

```ts
export class LoginQrCoordinator {
  beginGeneration(): number;
  invalidateGeneration(): void;
  isGenerationCurrent(token: number): boolean;
  claimPoll(): boolean;
  releasePoll(): void;
}
```

- [x] **Step 4: Add polling lease and result classification tests incrementally**

逐个 RED→GREEN 覆盖：

1. 同一时间只允许一个 `claimPoll()`；
2. `releasePoll()` 后允许下一次检查；
3. `stored` 或 `loggedIn` 分类为 `success`；
4. `expired`、code `800/65` 分类为 `expired`；
5. `scanned`、code `802/67` 分类为 `scanned`；
6. 其他结果分类为 `waiting`。

- [x] **Step 5: Run and commit**

```powershell
bun test apps/web/src/features/accounts/login-qr-coordinator.test.ts
git add apps/web/src/features/accounts/login-qr-coordinator.ts apps/web/src/features/accounts/login-qr-coordinator.test.ts docs/superpowers/plans/2026-07-26-m1-account-qr-runtime.md
git commit -m "refactor(web): add login QR coordinator"
```

### Task 2: Extract the QR React runtime

**Files:**
- Create: `apps/web/src/features/accounts/useLoginQrRuntime.ts`
- Create: `apps/web/src/features/accounts/useLoginQrRuntime.test.tsx`

- [x] **Step 1: Write a failing QR generation tracer test**

渲染最小 harness，通过 fake `AccountPort` 打开网易云登录 modal，断言依次调用 `createLoginQrKey()`、`createLoginQrImage()`，并发布：

```ts
{
  qr: { key: "ne-key", img: "data:image/png;base64,ne", completed: false },
  status: { text: "使用网易云音乐 App 扫码，然后在手机上确认登录", tone: "idle" }
}
```

- [x] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/accounts/useLoginQrRuntime.test.tsx
```

Expected: FAIL because the runtime hook does not exist.

- [x] **Step 3: Implement the injected runtime minimally**

公开接口：

```ts
export interface LoginQrRuntimeResult {
  qrByProvider: Record<LoginProviderId, LoginQrState | null>;
  statusByProvider: Record<LoginProviderId, LoginQrStatusState>;
  refreshProviderLoginQr(provider: LoginProviderId): Promise<void>;
  resetProviderLoginQr(): void;
}
```

依赖：`AccountPort | null`、modal open/mode/provider、`onProviderStatus`、`syncProviderLibrary`、`refreshLibraryAfterLoggedOut`、`providerLabel`、`showToast`，以及测试可注入的 interval scheduler。不得导入 `SidecarClient`。

- [x] **Step 4: Add core runtime tests one behavior at a time**

逐个 RED→GREEN：

1. refresh/reset 使晚到的旧 QR image 失效；
2. success check 先同步 login status，再调用 provider library/Home 同步，最后完成二维码并发布成功 toast；
3. provider 切换后旧 check/login status 结果不提交；
4. interval 触发时已有 check in-flight 不启动第二次；
5. modal 关闭或 unmount 清除 interval；
6. expired/scanned/check failure 保持现有文案。

- [x] **Step 5: Run focused verification and commit**

```powershell
bun test apps/web/src/features/accounts
bun run --filter ./apps/web typecheck
git add apps/web/src/features/accounts docs/superpowers/plans/2026-07-26-m1-account-qr-runtime.md
git commit -m "refactor(web): extract login QR runtime"
```

### Task 3: Integrate App and enforce the boundary

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Create: `scripts/architecture/account-qr-runtime-boundary.test.ts`

- [x] **Step 1: Replace App-owned QR state and polling**

删除 `LoginQrState`/status types、initial status constants、`loginQrRequestSeqRef`、三个 QR/state pairs、`refreshProviderLoginQr`、`resetProviderLoginQr` 和 QR polling effect。App 从 `useLoginQrRuntime()` 读取三平台 QR/status 与 refresh/reset callbacks。

- [x] **Step 2: Route QR transport through AccountPort**

runtime 只使用：

```ts
appServices?.music.accounts.createLoginQrKey
appServices?.music.accounts.createLoginQrImage
appServices?.music.accounts.checkLoginQr
appServices?.music.accounts.loginStatus
```

资料库与 Home 同步继续使用 App 注入回调，现有 Cookie/logout 路径保持不变。

- [x] **Step 3: Add the architecture source guard**

断言 `App.tsx` 不再包含：

```text
loginQrRequestSeqRef
createProviderLoginQrKey(
createProviderLoginQrImage(
checkProviderLoginQr(
window.setInterval(() =>
```

并断言 App 调用 `useLoginQrRuntime()`、runtime 不导入 `SidecarClient`。

- [x] **Step 4: Run account/App characterization**

```powershell
bun test apps/web/src/features/accounts apps/web/src/app/App.test.tsx scripts/architecture/account-qr-runtime-boundary.test.ts
bun run --filter ./apps/web typecheck
bun run web:build
```

- [x] **Step 5: Commit integration**

```powershell
git add apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx scripts/architecture/account-qr-runtime-boundary.test.ts docs/superpowers/plans/2026-07-26-m1-account-qr-runtime.md
git commit -m "refactor(web): move login QR polling out of App"
```

### Task 4: Record evidence and run the frozen API audit

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-account-qr-runtime.md`

- [ ] **Step 1: Record QR runtime ownership only**

记录二维码生成和 polling 已迁移；`accounts.multi-provider` 保持 `baseline`，Cookie、logout 和完整 accounts controller 仍未完成。

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
git diff d33dc6e..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

- [ ] **Step 3: Commit evidence**

```powershell
git add docs/parity docs/superpowers/plans/2026-07-26-m1-account-qr-runtime.md
git commit -m "docs: record login QR runtime extraction"
```

## Completion checkpoint

- `App.tsx` 不再拥有 QR generation token、poll interval 或 check in-flight 状态；
- QR API 只通过 `AccountPort`；
- 三平台现有二维码、成功同步、过期和扫码文案保持；
- Cookie/logout 和其他账户能力未被改动；
- frozen API diff 为空。
