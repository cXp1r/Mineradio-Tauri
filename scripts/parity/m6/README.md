# M6 Full Desktop evidence

M6 的自动代码门禁与 Windows 实机证据分开记录。

`capture-evidence.mjs` 会冻结 Bun Sidecar、shared DTO、sidecar 构建脚本和既有 API/media client seam。`tauri.conf.json` 的主窗口由 Rust 动态创建是 M6 授权变更，因此不会整文件 freeze；runner 仍会从指定 baseline 读取配置，并严格比较 `bundle.externalBin`。基线不可读取、JSON 无效或该字段改变都会 fail closed。

```powershell
node scripts/parity/m6/capture-evidence.mjs --manual output/parity/m6/manual.json --strict
node scripts/parity/m6/verify-evidence.mjs output/parity/m6/manifest.json
```

`Code Complete` 只要求自动代码门禁通过。`Field Validated / Release Verified` 还要求 strict manifest 具备带时间戳和产物的双屏混合 DPI/负坐标、Explorer 重启、进程 kill 恢复、Escape/托盘/正常退出、至少 30 分钟后台 soak 与无残留 desktop state 证据；缺失这些实机证据不阻止 M6 Code Complete。
