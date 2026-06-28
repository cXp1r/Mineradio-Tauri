# apps/desktop/src-tauri

Rust + Tauri 2 + WebView2 主壳。薄运行时 + 系统/窗口/外部/sidecar 生命周期；provider/cookie/账号所有业务在 Bun sidecar。codegraph/LSP 未启用 — centrality unmeasured。

## STRUCTURE

```
src/
├── main.rs           # 3 行 entry，调 lib::run()
├── lib.rs            # RuntimeConfig + AppState + run() orchestrator + sidecar setup hook
├── commands.rs       # Tauri command handlers + reserved window labels
├── sidecar.rs        # 协程：端口分配 / 命令构造 / 原生 TcpStream 健康轮询 / HealthInfo 解析 + SidecarError enum
├── paths.rs          # dirs::data_dir()/Mineradio + MINERADIO_APP_DATA_DIR/MINERADIO_LOG_DIR env 覆盖
└── updater.rs        # stub: stub_updater_status() 返 available:false（待 P10）

capabilities/
└── default.json       # core:window/event/webview/app only，scope ["main"]；Rust-owned dialogs 不暴露 renderer plugin commands

tauri.conf.json        # 单窗口 main 1280x720，identifier com.mineradio.fork.tauri，CSP null (dev)
Cargo.toml             # deps: tauri 2 / tauri-plugin-dialog / serde / serde_json / dirs 5；GPL-3.0 license
build.rs               # tauri_build::build()
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 加新 Tauri command | `commands.rs` 加 `#[tauri::command] fn ... -> Result<T, String>` + `lib.rs::run()` `tauri::generate_handler![...]` 注册 | 错误统一 `Result<T, String>`，把 error code/struct 序列化为字符串前端解析；include `provider` 等字段 |
| 加新 sidecar capability / plugin | `capabilities/default.json` 在 `permissions` 数组加；当前 JSON import/export dialogs 由 Rust commands 调 `DialogExt`，不向 renderer 授权 `dialog:allow-open` / `dialog:allow-save`；新 JS-side plugin command 加后才需要 Tauri 权限 + capabilities 双重配置 | 见 `commands.rs::open_external` 用 `std::process::Command` 直 OS 派发以绕过 plugin 缺失 |
| 改 sidecar 拉起 | `lib.rs::run()` 内 `setup` 闭包调 `sidecar::build_sidecar_command(port, app_data_dir, log_dir, app_version)` + `spawn_sidecar` + `wait_for_health(base_url, 2s deadline)` | setup 失败不挂 startup（仅 `eprintln!`）—— 给 tauri dev run 无 Bun PATH 时容错；未来要加 panic-back 给通知 |
| 改 sidecar binary args | `sidecar.rs::build_sidecar_command`：`bun` + `["run", "sidecars/api/src/server.ts"]` + 4 env vars (`MINERADIO_SIDECAR_PORT/APP_DATA_DIR/LOG_DIR/APP_VERSION`) | 不要 hardcode port，用 `allocate_port()` |
| 加 Tauri 多窗口 | `commands.rs labels::DESKTOP_LYRICS / WALLPAPER / LOGIN_NETEASE / LOGIN_QQ` 已 reserved；创窗 Tauri Rust 创建 `WebviewWindowBuilder`，挂对应 capabilities (`windows:["desktop-lyrics",...]`) | login 窗口对应 sidecar 登录流程；不要在 Rust 存 cookie |
| 改 path 行为 | `paths.rs::resolve_app_data_dir` / `resolve_log_dir`；env 覆盖 helper `with_override(dir, fallback)` | 新目录只能在 `Mineradio/*` 下，不要扩到其他 app id 区分 |
| updater | `updater.rs::stub_updater_status` 是 placeholder —— P10 这边返真实 updaterState + Tauri updater plugin 接入 + capabilities 加 `updater:default` | 当前 stub 给前端 update-store 用占位 |
| ticking sidecar 健康过短过长 | `sidecar.rs::wait_for_health(base_url, deadline)`：200ms sleep 重试直到 deadline；level too short 可能识别不上 sidecar | 2s 在 tauri dev 可能短，要看 cold-start 平测 |

## CONVENTIONS（仅记录偏离标准）

- **RuntimeConfig/AppState 在 builder 里 `.manage(state)` 注入**：所有 `#[tauri::command]` 接 `tauri::State<'_, AppState>` 拿 config，避免全局变量
- **sidecar base URL = `format!("http://127.0.0.1:{}", port)`**：port 由 `allocate_port()` TCP listen `127.0.0.1:0` + 立即 drop 让 OS 分配；不要 hardcode 3000
- **sidecar 健康轮询用 raw TcpStream**：不引 reqwest/hyper 等 HTTP client crate；手动写 `GET /health HTTP/1.1\r\nHost: ...\r\nConnection: close\r\n\r\n` 读 1MB buffer + `windows(4).position(b"\r\n\r\n")` 切 header/body + 解析 status line `" 200 "` 子串 + serde_json 取 body
- **cookie 不进 Rust state**：sidecar 拥有所有 auth；Rust 只跑 lifecycle/窗口；OAuth/login windows 是展示 webview，sidecar 那侧拿 cookie/env/redirect
- **`open_external` URL 守护**：`is_openable_url(url)` 只允 `http://`/`https://` 起始；防 `file:///`/`javascript:`/`data:`
- **capabilities 最小集**：当前只授权 renderer core:window/event/webview/app:default；Rust-owned JSON dialogs 使用 `tauri_plugin_dialog::DialogExt`，不暴露 renderer dialog plugin commands。新功能（shell/updater 或 JS-side fs/dialog）必须**先加 capability 再创命令**，否则 Tauri `invoke` 返 permission denied
- **commands 不写 panic 且不直接 await I/O**：所有副作用返回 `Result<(), String>` 让 UI 处错误；返回 String 给 UI translator
- **`paths.rs with_override(dir, fallback)`**：env 给空白或 whitespace 字符串也用 fallback，不空指针；测试笑着说可设任意字符串再 restore
- **wait_for_health Time out 时 `SidecarError::Timeout` 不带原因**：后续可记录上一次重试失败的原因放到 SidecarError 字段 —— 待 P9 P.a sidecar 崩溃重启 slice

## ANTI-PATTERNS (THIS PROJECT)

- **不要在 Rust 里读 cookie / oauth token**：所有 auth 集中 sidecar；login flow 在 Tauri webview 展示但 token 写到 sidecar cookie env / memory。Rust `AppState` 持 0 用户私密字段。
- **不要在 `setup` 闭包里 `expect` sidecar spawn OK**：当前容错 `eprintln!` 而不 panic —— broke Bun 不在 PATH 时让 `tauri dev` 仍可跑。后续可改 + UI 错误通知。
- **不要 import `tauri-plugin-shell` / `tauri-plugin-opener` 等 unless capabilities 也加**：当前 `open_external` 用 `std::process::Command` 直接派发到 OS 程序，**绕开 plugin 路径**。如要 plugin `shell:allow-open`，要 capabilities + plugin 双配置；选其一。
- **不要 hardcode Windows-side command**：跨 OS 在 `open_external` 用 `cfg!(target_os="windows"|"macos"|"linux")` 三分支；sidecar spawn 默认用 `"bun"` 程序名（PATH 查找），如未来要全局 absolute 路径 spawn，可加 env `MINERADIO_BUN_PATH`。
- **不要在 `build_sidecar_command` 设 working directory 到主工作区**：默认继承 Rust 进程 cwd，sidecar 自己找 `sidecars/api/src/server.ts` 相对 path；如有问题加 `cmd.current_dir(workspace_root)`。
- **不要在 capabilities 加 shell/dialog/fs/updater 而不接 JS-side plugin command**：permission 默认 fail。Rust-only dialog usage 已接 `tauri_plugin_dialog::init()`，但无需 renderer ACL。
- **不要用 reqwest/hyper**：sidecar.rs 选择 native TcpStream 显控制 raw HTTP；这是为了**零额外 dependency、最小 crate footprint、不增加 license audit 行** —— 与 DECISIONS A1-A8 「最小依赖 / license allowlist 收紧」一致。

## UNIQUE STYLES

- **5 reserved window labels**：`MAIN/DESKTOP_LYRICS/WALLPAPER/LOGIN_NETEASE/LOGIN_QQ`；当前只 main 在 tauri.conf.json 创建；其他 4 个留给 P9/P10 切片
- **no HTTP client dep**：所有 sidecar 健康检查走 stdlib `TcpStream`；后续如要真正 sidecar HTTP 代理 / cookie 注入，也是 sidecar 内部 Bun 处理，不回 Rust 桥
- **port allocation via TcpListener + drop**：通过 listener bind 后立即 drop 让 OS 分配端口；进程可能拿到 0.1ms 同端口冲突 race，**测试中**：`wait_for_health_succeeds_against_test_listener` 验证 in-test TcpListener 模式
- **export/import JSON 已接 Rust-owned dialogs**：`export_json_file(fileName,data)` 打开 save dialog、写 pretty UTF-8 JSON、只返回 `cancelled/path`；`import_json_file()` 打开 open dialog、读 UTF-8、解析 JSON、返回 `cancelled/path/data`。路径只来自 dialog，不接受前端任意路径。
- **updater.rs 26 行 stub**：`stub_updater_status()` 返 `UpdaterStatus { available: false, version: None, message: None }`；P10 接 Tauri updater plugin
- **icon**：`apps/desktop/src-tauri/icons/icon.ico`（com.mineradio.fork.tauri 包）—— 临时复用 build/icon.ico，DECISIONS A2 锁定为最终发布 logo
- **Cargo.toml license `"GPL-3.0"`**：crate 与 sidecar `qq-music-api` 同 license；组合 bin 可在 GPL-3.0 下分发

## COMMANDS

```powershell
$bun = "C:\Users\zhanw\.bun\bin\bun.exe"
# BUN 必须在 PATH 或 spawn 失败 —— tauri dev 启动需要能找到 bun 可执行文件
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
& $bun run --filter ./apps/desktop tauri dev   # Tauri webview + sidecar 直跑
& $bun run --filter ./apps/desktop tauri build # 打 NSIS / installer
```

## NOTES

- codegraph/LSP 未启用；本表由 bg explore agent + 6 source file 直读构造。
- **Bun spawn 用 `"bun"` 程序名 + `["run", "sidecars/api/src/server.ts"]`**：要求 PATH 含 `bun.exe`，或 controller 启动前 `env PATH` 注入 `C:\Users\zhanw\.bun\bin`。spawn 失败时 setup hook 容错 `eprintln!` 不挂启动 —— **未来 sidecar 崩溃重启 slice (P.a 待办)** 要加 panic-back 通知前端 `/error` channel。
- **capabilities/default.json scope `["main"]`**：所有权限只绑主窗口；创建 DESKTOP_LYRICS 等新窗口时**必须新建 capability JSON 或扩 scope**，否则命令在该窗口上 forbidden。
- **`tauri.conf.json` CSP `"null"`**：dev 阶段无 CSP；P10 release 时**需要收紧** 至基线允许域，permit `img-src https://y.gtimg.cn http://p4.music.126.net/...` 等 cover CDN 域 + sidecar 自身 `connect-src http://127.0.0.1:*`。当前 dev 无 concern。
- **Cargo.lock 已提交（依赖已固）**；新 dep 须先 license 审核后记入 `docs/migration/LICENSE_GATE.md` Dependency Audit。
- **manual `tauri dev` 验证**：Bun 在 PATH 后启动成功 = 窗口立现 + sidecar `/health` 200；sidecar base url 注入 React 通过 invoke `get_runtime_config` 拿 `sidecar_base_url`。
- **Tauri updater 拐弯**：updater.rs 通过 `invoke("get_updater_status")` (待加) 让 frontend 更新 update-store；后面 wireup Tauri `tauri-plugin-updater` 在 `Cargo.toml` + capabilities `updater:default` + tauri.conf.json `plugins.updater.endpoints`.
