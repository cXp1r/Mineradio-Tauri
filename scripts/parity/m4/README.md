# M4 视觉证据采集

该 runner 通过 `@playwright/cli` 驱动真实 Edge/Chromium，调用隔离的
`?m4-parity=1` 页面 contract，不加载普通 `App`、Sidecar 或账户状态。

## 运行

先构建并启动最新 Web preview：

```powershell
bun run web:build
bun run --filter ./apps/web preview -- --host 127.0.0.1 --port 4173 --strictPort
```

另一个终端执行 quick evidence：

```powershell
node scripts/parity/m4/capture-evidence.mjs
```

Release soak 与硬门：

```powershell
node scripts/parity/m4/capture-evidence.mjs --profile release --strict
```

如果 preview 使用其他端口：

```powershell
node scripts/parity/m4/capture-evidence.mjs --base-url http://127.0.0.1:4174/
```

脚本默认使用 `msedge`、`1920×1080`、DPR 1、`zh-CN`、
`Asia/Hong_Kong`、deterministic scheduler 和 seed `20240728`。每个场景使用
独立 Playwright CLI session，并在结束时只关闭自己的 session。

## 产物

默认目录为 `output/playwright/m4/`：

```text
manifest.json
stage/
├─ stage-steady-4200ms.png
├─ stage-after-seek.png
├─ stage-seek-transition.webm
└─ evidence.json
sonic/
├─ sonic-eco-1920x1080.png
└─ evidence.json
shelf/
├─ shelf-600x600-soak.png
└─ evidence.json
```

`manifest.json` 和各场景 `evidence.json` 记录：

- commit、branch、dirty 状态和完整 CLI 命令；
- 浏览器版本、UA、viewport、DPR、字体、WebGL vendor/renderer；
- `performance.frames` 与 gate p50/p95；
- resource current/peak/budget/pressure；
- task queue 与 subsystem diagnostics；
- Three.js renderer draw/memory counters；
- Stage、Sonic、Shelf 的结构硬门。

Release strict 还会拒绝：dirty worktree、preview 内嵌 build commit 与当前 HEAD 不一致、
任一场景 console error 非零，以及缺少真实 GPU timer-query 扩展或样本。`--strictPort`
确保旧 4173 preview 不会被 Vite 静默绕到其他端口。

## GPU 计时语义

证据页已把真实 `GpuFrameTimer` 接入 production presentation seam。它围绕正式 renderer
presentation 发起 `EXT_disjoint_timer_query_webgl2` query，并在后续帧非阻塞回收结果。

- 只有 query 已 resolved、GPU 未处于 disjoint 状态、`sampleCount > 0` 且 p50/p95
  均为有效值时，才记录 `gpuTiming.status = "measured"` 与 `measured=true`；
- 扩展可用但尚无有效样本时记录 `status = "proxy"`、`measured=false`，CPU frame
  cost、draw calls、triangles/points/lines 仍只是 proxy；
- 扩展不可用时记录 `status = "unavailable"`，release strict 直接失败；
- disjoint query 会被丢弃，不能伪造为有效 sample；
- `--profile release --strict` 在扩展可用但 `sampleCount=0` 时必须失败。

因此，扩展能力探测不能代替真实 GPU 测量，proxy 数据也不能称为 GPU p95。

## 验证 runner

```powershell
bun test scripts/parity/m4 --parallel=1
node --check scripts/parity/m4/capture-evidence.mjs
git diff --check -- scripts/parity/m4
```
