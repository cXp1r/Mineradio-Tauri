# sidecars/api

Bun-HTTP sidecar：provider gateway、统一 envelope、Netease + QQ adapter。所有 provider 协议差异锁在 adapter 层，前端不处理分支。

## STRUCTURE

```
src/
├── bun-env.d.ts                    # Bun 全局类型 (process.env / Bun.serve / bun:test)
├── env.ts                           # 4 个 MINERADIO_* env 读取器
├── server.ts                        # Bun.serve entry + routeHandler + statusFromError
├── server.test.ts                   # router-level 集成测试
├── http/
│   ├── envelope.ts                  # envelope contract: ok<T>/fail/json
│   └── envelope.test.ts
├── providers/
│   ├── provider-adapter.ts         # ProviderAdapter 接口 + 2 个 Error 类
│   ├── registry.ts                  # provider registry + buildCapabilityMatrix
│   ├── registry.test.ts
│   ├── netease/
│   │   ├── hana-client.ts            # hana-music-api 包 wrapper + getConfig
│   │   ├── netease-adapter.ts        # createNeteaseAdapter DI 工厂 + 单例
│   │   ├── netease-adapter.test.ts
│   │   ├── map.ts                    # HanaSong→Track / parseLrc / mapHanaLyricToPayload / playlist
│   │   └── map.test.ts
│   └── qq/
│       ├── qq-client.ts              # jsososo/qq-music-api (GPL-3.0) CJS 桥
│       ├── qq-client.test.ts
│       ├── qq-adapter.ts             # createQqAdapter DI 工厂 + 单例
│       ├── qq-adapter.test.ts
│       └── map.ts                    # QqSong→Track / parseLrc / mapQqLyricToPayload / playlist
└── services/
    ├── fallback.ts                  # normalizeError: 3 分支 → envelope
    ├── cross-source-resolver.ts     # provider-agnostic search/songUrl fallback + source switching
    ├── diagnostics.ts                # buildDiagnostics + pushRecentError ring buffer (cap 20)
    ├── diagnostics.test.ts           # cookie-leak 回归 assert
    └── audio-proxy.ts                # stub，返回 NOT_IMPLEMENTED
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 新增 provider | 在 `providers/<id>/` 加 `client.ts` + `adapter.ts` + `map.ts` + `.test.ts`，在 `registry.ts` 注册 + capability matrix 加行 | 见 netease/qq 模板：工厂 `createXxxAdapter(deps?)` + `defaultDeps` + 单例 export；所有方法接受 `query + config { cookie? }` |
| 调整 envelope | `http/envelope.ts` + `packages/shared` ApiSuccessSchema/ApiFailureSchema + `services/fallback.ts` | NormlizeError 把 ProviderError → envelope；新加 ProviderError 子类要在 fallback.ts 接管 |
| 加新路由 | `server.ts` routeHandler 加 if 分支；test 在 `server.test.ts` 加断言 path + envelope；404 默认走 NOT_FOUND | routeHandler 是 module-level async fn，测试直接调 |
| 改 capability matrix | `providers/registry.ts` buildCapabilityMatrix + registry.test.ts | 现 netease / qq 均 `available:true`（7c32b2b 后） |
| 改 diagnostics | `services/diagnostics.ts` buildDiagnostics；test 强 assert cookie/auth keys 不出现 | 添加字段时**不要包含 cookie/MUSIC_U/qm_keyst/qqmusic_key/wxskey** |
| 加跨源 fallback | `services/cross-source-resolver.ts` + routeHandler `/search` 和 `/song-url` provider-agnostic 路由 | 代码侧已落地：preferred/registry-order fallback、空结果继续尝试、songUrl 通过 title/artists 搜索候选换源；WebView2 手动 provider evidence 待补 |
| Bun CJS interop | `providers/qq/qq-client.ts:22-33` 用 `import.meta.require("qq-music-api")` | 不要用全局 `require()` —— 无 @types/node，typecheck 报 TS2580 |

## CONVENTIONS（仅记录偏离标准）

- **DI-seam 适配器工厂模式**：两个 provider 都照同一模板：
  1. `XxxDeps` interface：每个 method `(query, config?) => Promise<{body:unknown}>` + `getConfig(): { cookie?: string }`
  2. `cast(fn)` 类型擦除（`fn as unknown as Xxx`）绕 npm 包未类型化导出
  3. `defaultDeps` 默认注入真实 client 单例
  4. `cfgOf(deps)`: `deps.getConfig().cookie ? { cookie } : {}` —— 只在有 cookie 时传 config
  5. `createXxxAdapter(deps?)` 工厂返回 ProviderAdapter 字面量
  6. `xxxAdapter = createXxxAdapter(defaultDeps)` 单例 export 给 registry
  7. 测试 `noopDeps(overrides)`: noop callable + 覆盖单方法
- **Cookie env 每次调用读**：`getConfig()` 不缓存 cookie 字符串到模块级；测试可 `withEnv(key,value,fn)` 临时改环境后 restore。
- **No-cookie diagnostic 回归**：`diagnostics.test.ts` + `server.test.ts` 都显式 assert `JSON.stringify(payload)` 不包含 `cookie`/`MUSIC_U`/`qm_keyst`/`qqmusic_key`/`wxskey` keys。改 diagnostics payload 前务必加 assert 通过这个 gate。
- **Byte-equal port 启发**：DI 工厂模板受 `sidecars/api/src/providers/netease/netease-adapter.ts` 3c30dd6 commit 锚定，QQ 7c32b2b 同 shape，**不要改两套去凑创新**——若改一处为 baseline 对齐 / 类型收紧时，**另一处也必须对齐**。
- **Adapter lazy CJS 适配**：QQ `qq-client.ts` 通过 `import.meta.require` 单次加载 jsososo 的 CJS package，缓存在 `cachedModule: QqApiModule | null`；`qq.setCookie()` 在 singleton 进程级 mutate 状态（**single cookie owner assumption**，见 qq-adapter.ts `// NOTE:`）。
- **Cross-source resolver DI seam**：`createCrossSourceResolver({ providers, providerOrder })` 用 fake adapter 做服务测试；`createRouteHandler({ crossSourceResolver })` 只给 provider-agnostic `/search`、`/song-url` 注入，旧 `/providers/:provider/*` 分支继续直连 registry adapter。

## ANTI-PATTERNS (THIS PROJECT)

- **不要存 cookie 在 module-level 变量**：getConfig() 每次读 `process.env.MINERADIO_*_COOKIE`；存到模块变量会跨 request 串音。
- **不要把 cookie 值带进任何 Response.json 体**：包括 diagnostics / 错误 message / ProviderError.message；测试 assert cookie 字符串 substring 不出现。
- **不要让 adapter 直接抛 raw `Error`**：用 `ProviderError("qq"|"netease", code, message, { retryable, action? })` 让 `normalizeError` 包装成 envelope。
- **不要用全局 `require()`**：sidecar 包无 @types/node，typecheck TS2580；用 `import.meta.require` 或 `await import(...)` 中段 require。
- **不要把 jsososo/QQMusicApi 接进主分支 ≠ jsososo/qq-music-api `^1.1.2`**：`sansenjian/qq-music-api` 不接入（README 非商业附加条款与 GPL-3.0 冲突）。见 `docs/migration/LICENSE_GATE.md` QQ 项目审核表。
- **不要在 sidecar 里实现 updater**：updater 在 Tauri 主壳（apps/desktop）。
- **不要给 songUrl 接 anchor-less Netease anonymous 默认 high-res 音质**：hana songUrlV1 在无 cookie 时被 QQ 路径包裹成 `ProviderError LOGIN_REQUIRED retryable:true action:"login"`，对 Netease 匿名路径 fee:0 standard 是 OK 的——见 `netease/map.ts:mapPlayable`。

## UNIQUE STYLES

- **跨 provider 都用 `asObj(v)` null 守护**（在两个 adapter 里重复定义）—— 后续可抽 utils。
- **`parseLrc` 在 netease map.ts 和 qq map.ts 各一份字面相同 copy** —— 后续抽 utils 共享。
- **类型擦除 `cast(fn)` 在两个 adapter 各有** —— Pandore，但相对清晰。
- **QQ loginStatus 只信 cookie 存在不走网络**：`qq-adapter.ts:166-170` 早期返回 `loggedIn:true` 当 cookie 存在；**不验证 cookie 有效性**。Netease 反而真的调 hana.loginStatus + 解析 profile。
- **QQ logout 是 best-effort+swallow**：`qq-adapter.ts:176-181` 调 jsososo `user` 路由后吃掉任何错误。Netease logout 调 hana.logout 但不验证响应。

## COMMANDS

```powershell
$bun = "C:\Users\zhanw\.bun\bin\bun.exe"
& $bun test sidecars/api                    # 69 pass / 0 fail current
& $bun run --filter ./sidecars/api typecheck
& $bun run --filter ./sidecars/api dev      # 起 Bun.serve 实测 /health
node --check server.js                       # legacy baseline 不能挂
git diff --check
```

## NOTES

- 测试端到端：当前 `sidecars/api/src/server.test.ts` 内 Netease search/songUrl/lyric/playlists 路由测试**会触达真实 Netease 网络**（最近 commit 改 placeholder → 真 adapter 后写的 envelope shape 测试），CI 离线时会 flaky；观察是否需要后续注入 fake transport。
- `audio-proxy.ts` 是 NOT_IMPLEMENTED stub — audio proxy 走跨越 CORS preflight 阶段，落地需要 origin-proxy 决定方案，未在 P4-P10 任何 gate 完成。
- license：QQ 客户端依赖 `qq-music-api` (GPL-3.0)；sidecar 是私有 Bun 工作区（`@mineradio/sidecar-api` private:true），不开源分发包随 binary 分发时需 NOTICE / GPL 通告 (见 P10.c 待办)。
- Transitive deps `axios/cheerio/express/jade/js-base64/moment/xml2js/cookie-parser` 全部 GPL/MIT/BSD 兼容，已记入 `docs/migration/LICENSE_GATE.md` Dependency Audit 表 [transitive via qq-music-api].
