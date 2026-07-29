# M7 Windows Field Validation

M7 的 Windows 实测不阻断已完成的代码项。当前主背景 transport 是 DWM；原生 WGC/D3D
frame pool 尚未启用，`glassSamplerReady=false`，底栏使用现有 DOM/static fallback。
`wgcGlassFallback` 证书必须写入 `mode: "unsupported-dom-fallback"`，只验证该 fallback，
不能据此宣称 native WGC 已实现。未来若启用 native WGC，需另增 WGC capture 实测项。

真实官方 Scene、DWM、静音听感、真实光标、混合 DPI、Explorer 重启和
tray/crash/exit soak 统一标记为 **Field Validation Pending (non-blocking)**。

先按 `evidence-model.mjs` 的检查 ID 编写手工 JSON。`trayCrashExitSoak` 必须记录
`durationMinutes >= 30`；混合 DPI 项必须记录至少两个显示器、100%/150% 缩放和位于主屏
左侧的负坐标。然后采集包含 API freeze、`externalBin` 和工作树事实的 manifest：

```text
node scripts/parity/m7/capture-evidence.mjs --strict --manual <manual.json> --output output/parity/m7/manifest.json --baseline a2e845b
node scripts/parity/m7/verify-evidence.mjs output/parity/m7/manifest.json
```

runner 会 fail-closed 检查 Windows host、干净工作树、Sidecar/shared/media/externalBin freeze、
每项证书、观测时间、artifact 列表、混合 DPI 拓扑和 30 分钟 soak。它不会理解截图、声音、
鼠标或 Explorer 行为的内容，因此不能把“证据完整”解释为自动验证了视觉和听感。
