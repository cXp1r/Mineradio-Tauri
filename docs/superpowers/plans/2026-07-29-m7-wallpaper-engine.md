# M7 Wallpaper Engine 实施计划

**设计：** `docs/superpowers/specs/2026-07-29-m7-wallpaper-engine-design.md`

**当前状态：** Code Complete / Windows Field Validation Pending (non-blocking)

**范围冻结：** 不修改 Bun Sidecar、现有音乐 API、shared DTO、Provider、media URL 与 `bundle.externalBin`；不进入 M8/M9；不接入开发中的 Rust `mineradio-api`。

## Tracer 1：冻结 M7 transport 和 architecture seam

- 在 desktop command manifest 追加且只追加九个 M7 command；
- 添加 `WallpaperEngineRuntimePort` 与 Tauri Adapter；
- 添加 M7 command contract、runtime seam、禁用 helper/localhost/input injection 和 API freeze tests；
- 保持 command 为薄 Adapter，Win32 只存在于 `platform/windows/wallpaper_engine`。

验证：M7 architecture tests RED→GREEN；既有 M1–M6 manifest tests 不回退。

## Tracer 2：Library/project vertical slice

- RED：固定 project fixture，验证 image/video/Scene/preview-only、PKGV、containment 和 24-hex ID；
- GREEN：实现 `project.rs` public classification interface；
- RED：手工 root/package 上限、bounded scan、去重和配置原子持久化；
- GREEN：实现 `WallpaperLibrary` 和 memory/file store；
- 接入 Windows Steam/VDF/registry discovery；
- 实现 Tauri-only library snapshot，不暴露 raw path；
- 接入只读 custom media protocol 的 ID/role lookup 与 Range。

验证：Rust core tests、fixture traversal/symlink tests、protocol range tests。

## Tracer 3：Scene ownership/state/recovery vertical slice

- RED：唯一 24-hex session/location、generation supersede、close-old-before-open-new；
- GREEN：实现 `WallpaperEngineRuntime`、`WallpaperEnginePlatform` seam 和 fake Adapter；
- RED：targeted stop 不取消新 pending、idle dispose 幂等、close failure 保留旧 active；
- GREEN：实现 stop/switch/dispose；
- RED：journal 原子写、未知 schema、cleanup required、下一次启动 exact recovery；
- GREEN：实现 `wallpaper-engine-recovery-v1.json` 和 startup recovery；
- RED：ownership identity mismatch/PID reuse 不得 kill/close；
- GREEN：实现 typed identity 与 fail-closed policy。

验证：只通过 public runtime Interface 测可观察行为，不测试 private helper。

## Tracer 4：Windows Scene/DWM/WGC Adapter

- Steam installation/executable discovery；
- Authenticode、安装路径、现有同名进程 path 和 elevation gate；
- control ready/open/applyProperties/close command；
- exact title + PID/executable/creation-time HWND discovery；
- 2 px physical geometry 校验与最多三次 reopen；
- 同进程 click-through DWM surface、thumbnail、follow/rebind/z-order；
- optional WGC glass owner 与 deterministic resource drop；
- location-scoped mute retry；
- 严禁 Scene `SetParent`/hide/park 和 synthetic pointer relay。

验证：Windows compile/clippy；pure policy tests；platform field facts 保留待实测状态。

## Tracer 5：App lifecycle 与 M6 Full Desktop 协同

- AppState 装配 Library、runtime、surface/capture owner；
- startup recovery 发生在 wallpaper auto-resume 之前；
- passive 前 preview-ready/stop gate；interactive icon-host layering；
- main move/resize 时更新 physical rect，不重启 Scene；
- minimize/hide/navigation/crash/tray/exit 汇合到同一 stop/dispose path；
- shutdown 固定为 Full Desktop rollback → Wallpaper capture/location cleanup → M5/Sidecar cleanup；
- diagnostics 只读暴露 phase、journal、identity validation、DWM/WGC/mute 和最近错误。

验证：fake runtime 的 lifecycle ordering、exactly-once cleanup、timeout/journal retention tests。

## Tracer 6：Web feature 与 direct media

- `WallpaperEngineRuntimePort`/Tauri Adapter；
- feature controller/hook 负责 refresh/import/select/start/stop/recover；
- 控制面展示 library、source/safety、runtime/capture/mute/cleanup 状态；
- image/video/preview 使用 M7 custom protocol URL；Scene 使用 start/stop command；
- 保存用户选择，不保存 native HWND/PID/path；
- passive 前切静态 preview，interactive/top-level 后显式恢复；
- 现有 `App.tsx` 只接 feature host，不重新集中业务副作用。

验证：Port Adapter、hook race/stale generation、controls 和 fallback tests。

## Tracer 7：证据、文档与最终门禁

- `scripts/parity/m7` evidence manifest/runner；
- required artifacts：真实 Scene 截图/录屏、runtime diagnostics、DWM/WGC/静音/鼠标/Full Desktop/lifecycle checklist；
- runner 只校验证据完整性，不伪装判断视觉与听感；
- 更新 capability matrix、upstream source map 与上位设计 M7 状态；
- 标记 Windows 实测为 `Field Validation Pending (non-blocking)`。

最终执行：

```text
cargo fmt --all --check
cargo test --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
bun test --parallel=1 ...
bun run typecheck
bun run web:build
M7 architecture/API/evidence guards
git diff --check
```

M7 完成后停止，不进入 M8/M9。

## 实施结果

九个 additive command、Library/custom protocol、Scene ownership/journal、官方安装与 exact signer 校验、location mute owner、DWM surface、主动 capture reconcile、Web Background/controller、Full Desktop 协调和完整 lifecycle cleanup 均已落地。原生 WGC/D3D sampler 明确未启用，`glassSamplerReady=false`，DOM/static fallback Code Complete；这不是待实测即可晋升的 native WGC 实现。

最终自动门禁为 Rust `283 passed`、Updater signature `7 passed`、Bun/workspace `2148 passed`；Rust fmt、全 target/feature 离线 Clippy `-D warnings`、typecheck、Web production build、M7 architecture/evidence guards、API freeze（含 `bundle.externalBin`）与 `git diff --check` 全绿。真实官方 Scene/DWM、无黑闪、视频首帧、真实 cursor、静音听感、混合 DPI、Explorer restart 与 tray/crash/exit soak 保持 `Windows Field Validation Pending (non-blocking)`，只阻止 `Field Validated / Release Verified`，不阻止 M7 Code Complete。
