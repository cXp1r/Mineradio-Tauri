# apps/web

Vite + React 19 + Zustand + Tauri webview 前端。Electron `public/index.html` 迁移后的 React shell：搜索 → 播放队列 → 音频生命周期 → 歌词同步 → visual-engine host。codegraph/LSP 未启用 — centrality unmeasured。

## STRUCTURE

```
src/
├── main.tsx                # createRoot + StrictMode
├── styles.css              # shell 样式 + #visual-host fixed/inset:0/-z-index 容器
├── vite-env.d.ts           # vite/client + VITE_SPLASH 类型
├── bun-test.d.ts           # bun:test ambient 类型 stub
├── app/App.tsx             # App shell：phase machine + sidecar boot + audio+lyric lifecycle + splash + VisualEngineHost
├── tauri/
│   ├── runtime.ts          # isTauriRuntime() + runtime/window/import/export/login bridge
│   └── updater.ts          # Tauri updater detection-only bridge（B2 未签名时不下载/安装）
├── audio/
│   └── player-controller.ts # HTMLAudioElement event relay：play/pause/timeupdate/durationchange/ended/error
├── api/
│   └── sidecar-client.ts   # REST 客户端：health/capabilities/search/songUrl/lyric/playlistDetail，Zod parse 响应
├── lyrics/
│   └── select-current-index.ts # 防御性 sort by timeMs + 二分前向求当前行；返回 SORTED index
├── stores/                  # 8 个 Zustand store，flat
│   ├── playback-store.ts    # currentTrack/isPlaying/positionMs/durationMs/mode(single|loop|queue|shuffle)/queue
│   ├── provider-store.ts    # matrix/status/error matrix 派生
│   ├── visual-store.ts      # preset/intensity/custom + loadFromStorage/serialize (PersistedVisualStateSchema guarded)
│   ├── lyrics-store.ts      # payload/loading/error/currentIndex + reset
│   ├── shelf-store.ts      # shelf mode/camera/presence/podcast/merge settings，接 VisualEngineHost + 控制台
│   ├── ui-store.ts          # modal/consoleVisible
│   ├── update-store.ts      # Tauri updater check/status 结果桶，App.tsx + UpdateHost 消费
│   └── search-store.ts      # results/loading/error/provider/keyword
├── components/
│   ├── lyrics/LyricView.tsx        # memoized 排序 + lyric-current 高亮
│   ├── search/SearchPanel.tsx      # provider 切 (netease/qq；QQ sidecar 已接，UI gate 待移除) + playableState 标签 + DISABLED_STATES
│   └── search/play-search-result.ts # enqueue + playAt helper
└── visual/
    ├── SplashHost.tsx              # Splash engine 容器 + auto-dismiss 计时
    ├── VisualEngineHost.tsx        # visual-engine 流水线 react 容器（#visual-host 根 div）
    ├── useVisualEngine.ts          # visual-engine monolith：AudioContext + createRenderer + render loop + registered visual steps + 2 pointer subsystems
    ├── PlayerConsoleHost.tsx       # 控制台主体 + GSAP console motion + SVG glass，由 BottomControlsHost 挂入 App.tsx
    └── shelf-*.{ts,tsx} 4 files    # pointer interactions / focus zone / detail data / items mapper (host-side shelf 接 VisualEngineHost)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 加新 store | `stores/<name>-store.ts` 模式：`create<XState>()((set, get) => ({...}))`，flat 字段；在 `app/App.tsx` 消费 | 不要 nested slice；Zustand v5 vanilla API |
| 接 Tauri invoke | 唯一 Tauri 文件 `tauri/runtime.ts` —— `isTauriRuntime()` 检测 `window.__TAURI_INTERNALS__` 后 dynamic-import invoke | 不要在别处 import `@tauri-apps/api`；建立新 invoke 调用时通过 `getRuntimeConfig` 同 handler 模板 |
| 加 sidecar route 客户端 | `api/sidecar-client.ts` 加方法 + `ApiSuccessSchema(XxxSchema)` parse | 所有响应走 zod shared schemas，不要手写类型守卫 |
| 加 visual-engine 模块 mount | `visual/useVisualEngine.ts` `useEffect` 中按顺序创建 + `registerStep(slot, fn)` 注册 | 11 个 RenderStepSlot 顺序固定 (见 visual-engine AGENTS.md) |
| 加 SearchPanel provider | `components/search/SearchPanel.tsx` provider `<select>` 已启用 netease/qq；A6/7c32b2b 已接 sidecar QQ provider，Stage 2 已移除前端 QQ search gate | 加新 provider 1) 改 `search-store` default 2) 改 SearchPanel provider 数组 3) 保留 songUrl cookie-gated 错误提示路径 |
| 处理 lyric 索引 | `lyrics/select-current-index.ts` 防御 sort；同一 track 中 `selectCurrentIndex` 在 3 处调用（App timeupdate handler + App useMemo + LyricView useMemo）—— **performance follow-up**，可 memoize 中 |
| 处理 Tauri 缺失 (SSR/test) | `tauri/runtime.ts:isTauriRuntime` + `tauri/updater.ts` detection-only fallback；其他 SSR-safe（无 jsdom 依赖；所有 WebGL/Canvas 第一次用到时检查 typeof window） | 不要 spread guard 到每个组件；集中 Tauri bridge |

## CONVENTIONS（仅记录偏离标准）

- **Tauri invoke dynamic-import gating**: `getRuntimeConfig` 唯一 Tauri 调用点；`isTauriRuntime()` 三层 gate (`typeof window` → `window.__TAURI_INTERNALS__` → dynamic import)，保证 SSR + Bun test + 非 Tauri 浏览器都不破坏。所有其他模块通过 `getRuntimeConfig()` 间接获得 sidecar base url，不直接 import Tauri。
- **audio element create once on mount**: `app/App.tsx` `useEffect` 创建单个 `new Audio()` + `PlayerController`，存储在 `audioRef/controllerRef`；通过 `togglePlay()/setPosition/setDuration` 广播给 playback store。**多 Audio 实例 — 禁止**。
- **fallback `placeholderRuntimeConfig()`** 用于非 Tauri 测试 / `tauri dev` 启动早期 sidecar 未就绪：`{sidecarBaseUrl:"", appVersion:"0.0.0-dev", schemaVersion:"0.1.0"}`。下游若读空字符串会被 sidecar-client 拒绝 → phase `error`。
- **visual-store 持久化通过 `PersistedVisualStateSchema.safeParse`**：旧数据 / 不合法 JSON 返回 null 不 crash (见 `visual-store.ts loadFromStorage`)
- **lyric 时间戳防御性 sort by `timeMs`**: NCM lrc 经常简繁交叠同时间戳行；`select-current-index.ts` 复制 payload.lines → map+sort → 二分前向；返回 **sorted index** 不是 original index
- **shelf settings store**: localStorage `mineradio-tauri-shelf-settings-v1` 只存迁移版 shelf UI 设置；不要读写旧 Electron 私有布局键。

## ANTI-PATTERNS (THIS PROJECT)

- **不要在 visual/ 里直接 import `@tauri-apps/api`**: 只通过 `tauri/runtime.ts`。避免 SSR/test 触发 dynamic import 失败。
- **不要在 store 里写 fetch side-effect**：side-effect 都在 React 组件 `useEffect` 里；store 只持纯状态。`search-store` 为例：search 行为 live in `SearchPanel` `useEffect` + setter。
- **不要 spam `selectCurrentIndex` 调用** —— 性能敏感：当前 3 次 / timeupdate。新加调用必须 memoize 或 reuse。
- **不要在 `useVisualEngine` 里 wrap 17 try/catch 一次级清理查 dispose** —— 它已经被这样做了，但 add 时不要再重复；如果你要 dispose 新 handle，跟上同 pattern (单 try/catch)；不要忘了把 reference set 回 `null`。
- **不要画第二条 audio 流水线**：`PlayerController` 单实例化，多 audio URL load 会并行出错。
- **不要把 QQ search 和 QQ songUrl 混为同一个 gate**：7c32b2b 后 sidecar QQ search/lyric/playlistDetail 匿名路径已接；songUrl 仍 cookie-gated，会返回 LOGIN_REQUIRED。前端可放开 QQ search，但点击播放需走现有 playable/error 路径，不要假装无 cookie 可直播。
- **不要 import `import.meta.env.VITE_SPLASH===0` 时仍 mount SplashHost**：会无意义启动 WebGL + canvas。

## UNIQUE STYLES

- **single visual-engine host monolith `useVisualEngine.ts`**: 不拆；它 hold住所有 Three.js handle + render-loop step 注册（HomeVisual / Shelf / StageLyrics 等）+ 2 个 pointer 子系统 attach；组件内部拆 helper 即可，保持单 useEffect correctness。
- **17 try/catch disposeHandles**: visual-engine 各模块 dispose 不稳定（部分 throw on double-dispose）；逐个 try/catch 容错；新接的模块同样处理。
- **AudioContext lifecycle**: `useVisualEngine` owns the visual WebAudio/Three handles; add new handles to the existing dispose path and keep refs nulled after cleanup.
- **`shelf-store` 已接产品主流程**：App.tsx 从 store 读取 mode/camera/presence/showPodcasts/mergeCollections，VisualEngineHost 通过 refs 与 runtime right-click promotion 同步。
- **`update-store` 已接 Tauri updater 检测路径**：App.tsx 调 `getUpdaterStatus()` / `checkForUpdate()`，`components/shell/UpdateHost.tsx` 渲染 baseline-style 入口；B2 未签名时保持 detection-only。
- **`SearchPanel` 中文 play state labels**：未知 / 可播放 / 需登录 / VIP / 付费 / 无音源 / 试听；QQ search gate 已移除，但仍必须保留不可播放状态防误点，尤其是 `login_required`。

## COMMANDS

```powershell
$bun = "C:\Users\zhanw\.bun\bin\bun.exe"
& $bun test apps/web
& $bun run --filter ./apps/web build # tsc --noEmit + vite build (webview dist)
& $bun run --filter ./apps/web dev   # vite dev server
& $bun run --filter ./apps/desktop tauri dev   # Tauri webview 拉起 dist
& $bun run main-flow-policy:check    # 技术栈 + 产品主流程代码侧闭环 guard
```

## NOTES

- codegraph/LSP 未启用；本表由 4 个 bg explore agents + 4 file 探读构造。
- 已知 anti-pattern 全部都在文件内 `// NOTE:` 或者 README 注释，仅 8 处主要在 `qq-adapter.ts` 和 visual-engine 的 control 模块。
- App.tsx phase machine: loading → connected | error；sidecar health 5×800ms 重试策略。
- `audioElementSupported()` 守护与 `PlayerController.createAudioElement()` 内部同守护 **redundant**（浅显可考虑单守护）。
- Splash `autoDismissMs = 1180 + 980 + 600` 魔法数：来自 baseline `splash.exiting` 1180ms + content 680ms/timeline 980ms。
- `useVisualEngine.ts:positionRef` 是 `RefObject<number>`，每次 render 设值；不通过 React state 触发 re-renders —— stage lyrics / cinema camera 通过 ref 读最新时间。
- 所有 env `VITE_SPLASH=0` 关 Splash 容易调试。
