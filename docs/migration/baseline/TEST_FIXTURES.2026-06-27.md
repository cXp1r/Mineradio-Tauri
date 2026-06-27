# Baseline Test Fixtures

更新时间：2026-06-27

本文记录 Electron baseline freeze 期间已经确认的测试素材和待补齐项。

## Window Sizes

- `1920x1080`：`home-idle-window.png`
- `1280x720`：`home-idle-1280x720.png`、后续主界面和控制台截图

## Search Fixture

- 搜索词：`遇见`
- 搜索模式：`All`
- 截图：`verification\baseline\2026-06-27-ced5ec61\search-results-yujian-1280x720.png`
- 观察到的候选结果：
  - `遇见（纯音乐）`，来源标记 `NE`
  - `遇见`，月楠，来源标记 `NE`
  - `遇见`，零零，来源标记 `NE`
  - `遇见（R&B）`，韩棒，来源标记 `NE`
  - `遇见（陕西话）`，陕西燕子，来源标记 `NE`
  - `遇见`，孙燕姿，来源标记 `NE`，`VIP`

## Visual Archive Fixture

- localStorage 快照：`verification\baseline\2026-06-27-ced5ec61\visual-localstorage-snapshot.json`
- 已记录 key：
  - `mineradio-lyric-layout-v1`
  - `mineradio-user-fx-archives-v1`
  - `mineradio-diy-player-mode-v1`
  - `skull-preset-v2`
- 内置用户视觉存档名称：`默认测试`

## Pending

- 还未完成真实播放链路：播放、暂停、seek、下一首、ended。
- 还未确认歌词源和歌词同步截图/录屏。
- 还未选择最终用于全量 parity 的固定测试歌曲。
- 还未采集桌面歌词白底/黑底可读性和拖动/锁定录屏。
