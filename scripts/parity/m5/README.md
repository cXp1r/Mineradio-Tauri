# M5 Desktop Runtime evidence

该 runner 负责记录 commit、dirty 状态、Windows 版本、显示器、MineRadio 进程、API freeze 和人工 soak 结论。
它不会把单元测试或单屏模拟伪装成双屏 DPI 证据。

先复制 `manual-evidence.example.json` 到 Git 忽略的 `output/parity/m5/manual.json`，在真实 Windows
环境完成每项检查后再逐项改为 `true`。双屏硬门要求同时存在：

- 100% 主屏；
- 位于主屏左侧的 150% 副屏；
- 桌面歌词跨屏、热区中键和显示器移除/恢复均已手验。

采集普通 manifest：

```powershell
node scripts/parity/m5/capture-evidence.mjs `
  --manual output/parity/m5/manual.json
```

最终 Field/Release 硬门：

```powershell
node scripts/parity/m5/capture-evidence.mjs `
  --manual output/parity/m5/manual.json `
  --strict
```

`--strict` 在 dirty worktree、API freeze 非零、双屏 DPI 不满足或任一人工检查缺失时返回非零。它只阻止宣称 `Field Validated / Release Verified`，不阻止 M5 Code Complete 或进入 M6。
强制终止 `tauri dev` 后的进程状态不能作为 `closeExitNoOrphans` 证据。
