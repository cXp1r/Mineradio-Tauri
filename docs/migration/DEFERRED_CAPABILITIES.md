# Deferred Capabilities

更新时间：2026-06-28

迁移允许内部里程碑分阶段完成，但最终对外发布必须具备原项目完整能力。任何延期功能都必须在这里追踪，不允许无记录丢弃。

## 状态定义

- `active`：当前迁移阶段要完成。
- `deferred`：允许后续阶段完成，但发布前必须决策。
- `hidden`：实现前在新项目中隐藏入口。
- `removed-by-decision`：经用户明确批准后移除。
- `done`：已迁移并通过验收。

## 延期清单

| Capability | Status | 延期原因 | 补齐条件 | 发布前决策 |
| --- | --- | --- | --- | --- |
| Wallpaper Engine 深联动 | hidden | DECISIONS.md A7 已锁定发布前隐藏入口；深联动需要单独协议和打包验证，本阶段不实现 | 独立设计 Wallpaper Engine web 壁纸包和本地桥接方案后再开放入口 | 隐藏，除非后续阶段补齐并验收 |
| 实验壁纸模式 | hidden | DECISIONS.md A7 已锁定发布前隐藏入口；Windows WorkerW、WebView2 层级和穿透风险高 | Tauri 窗口层级、WorkerW 挂载和性能验证通过后再开放入口 | 隐藏，除非后续阶段补齐并验收 |
| 手势识别/hand-canvas | hidden | DECISIONS.md A7 已锁定发布前隐藏入口；不是核心播放闭环，高风险且依赖视觉性能 | React/visual-engine 稳定后迁移并验证摄像/手势开关后再开放入口 | 隐藏，除非后续阶段补齐并验收 |
| 旧 Electron patch JSON 系统 | removed-by-decision | Tauri updater 替代旧 patch 系统，二开项目不兼容旧更新通道 | 无 | 不进入 Tauri 主线 |
| 旧用户数据自动迁移 | removed-by-decision | 本项目为二开项目，不承诺读取旧安装用户数据 | 无 | 不进入 Tauri 主线 |
| QQ 独立 sidecar | deferred | 第一版先用一个 Bun API sidecar 内部 provider adapter | QQ provider 复杂到影响主 sidecar 稳定性时拆分 | 视实现复杂度决定 |
| Tauri 发布 logo / 最终品牌名 | deferred | 开发期只需 Windows RC 资源图标；最终公开发布 logo/品牌名需用户决策 | 用户确认 logo 资产和品牌名后替换 `apps/desktop/src-tauri/icons/` 并更新 productName/identifier | 补齐 |
| Tauri dev 期占位图标 | done | `apps/desktop/src-tauri/icons/icon.ico` 复用 Electron baseline `build/icon.ico`，按 `docs/migration/DECISIONS.md` A2 已定为最终发布 logo | 无 | 见 DECISIONS.md A2 |

## 管理规则

- 新增延期项必须写明原因和补齐条件。
- 发布前所有 `deferred` 项必须变成 `done`、`hidden` 或 `removed-by-decision`。
- `removed-by-decision` 必须来自用户明确同意。
- 视觉、播放、provider、桌面歌词、updater、license gate 不能作为整体延期项。
