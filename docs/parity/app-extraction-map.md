# `App.tsx` 提取映射

审计基线：`apps/web/src/app/App.tsx` 4960 行。`purity` 使用 `pure`、`browser-storage`、`DOM`、`Tauri`、`sidecar`、`React-runtime` 六种分类。

| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |
| --- | --- | --- | --- | --- | --- | --- |
| `SHOW_SPLASH` | constant | pure | none | `app/runtime/AppBootstrapRuntime.tsx` | App import-time config | 10 |
| `SIDECAR_STATUS_POLL_MS` | constant | pure | none | `app/runtime/sidecar-recovery-policy.ts` | recovery characterization | 1 |
| `SIDECAR_STATUS_READY_MAX_POLL_MS` | constant | pure | none | `app/runtime/sidecar-recovery-policy.ts` | recovery characterization | 1 |
| `SIDECAR_STATUS_HIDDEN_MAX_POLL_MS` | constant | pure | none | `app/runtime/sidecar-recovery-policy.ts` | recovery characterization | 1 |
| `SIDECAR_RECOVERED_NOTICE_MS` | constant | pure | none | `app/runtime/sidecar-recovery-policy.ts` | recovery characterization | 1 |
| `PLAYBACK_QUALITY_STORE_KEY` | constant | pure | none | `features/playback/playback-preferences.ts` | playback preference tests | 4 |
| `LONG_PAUSE_PLAYBACK_URL_REFRESH_MS` | constant | pure | none | `features/playback/playback-policy.ts` | App playback tests | 4 |
| `PLAYBACK_URL_MAX_AGE_MS` | constant | pure | none | `features/playback/playback-policy.ts` | App playback tests | 4 |
| `HOME_LISTEN_STATS_STORE_KEY` | constant | pure | none | `features/home/listen-history.ts` | home summary tests to add | 7 |
| `USER_CAPSULE_AUTO_HIDE_STORE_KEY` | constant | pure | none | `features/accounts/account-preferences.ts` | App UI tests | 6 |
| `PLAYLIST_PANEL_PIN_STORE_KEY` | constant | pure | none | `features/library/library-preferences.ts` | App UI tests | 7 |
| `DIY_MODE_STORE_KEY` | constant | pure | none | `features/settings/player-preferences.ts` | App UI tests | 9 |
| `DEFAULT_GLOBAL_HOTKEYS` | constant | pure | none | `features/desktop/global-hotkeys.ts` | global hotkey tests | 5 |
| `AccountVipBadge` | type | pure | none | `features/accounts/account-view-model.ts` | TopRightControls tests | 6 |
| `accountVipBadge` | function | pure | none | `features/accounts/account-view-model.ts` | add table test | 2 |
| `placeholderRuntimeConfig` | function | pure | none | `app/runtime/runtime-placeholders.ts` | runtime tests | 1 |
| `audioElementSupported` | function | DOM | probes browser Audio | `features/playback/audio-capabilities.ts` | PlayerController tests | 4 |
| `buildTrackLyricFallback` | function | pure | none | `features/lyrics/lyric-fallback.ts` | lyric fallback tests | 2 |
| `mergeProviderPlaylists` | function | pure | none | `features/library/playlist-merge.ts` | existing App export tests | 2 |
| `shouldUseCachedHomeDiscoverPlaylist` | function | pure | none | `features/home/home-cache-policy.ts` | existing App export tests | 2 |
| `normalizePlaybackQualityPreference` | function | pure | none | `features/playback/playback-preferences.ts` | add preference test | 2 |
| `readPlaybackQualityPreference` | function | browser-storage | reads localStorage | `adapters/storage/browser-preferences.ts` | App initialization tests | 4 |
| `savePlaybackQualityPreference` | function | browser-storage | writes localStorage | `adapters/storage/browser-preferences.ts` | App quality tests | 4 |
| `readBooleanPreference` | function | browser-storage | reads localStorage | `adapters/storage/browser-preferences.ts` | storage adapter tests | 2 |
| `saveBooleanPreference` | function | browser-storage | writes localStorage | `adapters/storage/browser-preferences.ts` | storage adapter tests | 2 |
| `clampNumber` | function | pure | none | shared local utility near consumer | App behavior tests | 2 |
| `playbackKeyForTrack` | function | pure | none | `features/playback/playback-key.ts` | playback tests | 2 |
| `DesktopLyricsPayloadContext` | interface | pure | none | `features/desktop/desktop-lyrics-payload.ts` | desktop snapshot tests | 5 |
| `CurrentBeatMapState` | interface | pure | none | `features/playback/playback-runtime-state.ts` | beatmap tests | 4 |
| `TrialBannerState` | interface | pure | none | `features/playback/playback-view-model.ts` | App trial tests | 4 |
| `PlaybackReloadReason` | type | pure | none | `features/playback/playback-policy.ts` | reload tests | 4 |
| `LoadedPlaybackUrlState` | interface | pure | none | `features/playback/playback-runtime-state.ts` | reload tests | 4 |
| `PlaybackReloadOptions` | interface | pure | none | `features/playback/playback-policy.ts` | reload tests | 4 |
| `LoginQrState` | interface | pure | none | `features/accounts/accounts-state.ts` | QR tests | 6 |
| `LoginQrTone` | type | pure | none | `features/accounts/accounts-state.ts` | QR tests | 6 |
| `LoginQrStatusState` | interface | pure | none | `features/accounts/accounts-state.ts` | QR tests | 6 |
| `LoginModalMode` | type | pure | none | `features/accounts/accounts-state.ts` | account modal tests | 6 |
| `LOGIN_PROVIDERS` | constant | pure | none | `features/accounts/provider-policy.ts` | provider tests | 2 |
| `INITIAL_NETEASE_QR_STATUS` | constant | pure | none | `features/accounts/qr-view-model.ts` | provider table test | 2 |
| `INITIAL_QQ_QR_STATUS` | constant | pure | none | `features/accounts/qr-view-model.ts` | provider table test | 2 |
| `INITIAL_SODA_QR_STATUS` | constant | pure | none | `features/accounts/qr-view-model.ts` | provider table test | 2 |
| `initialQrStatusForProvider` | function | pure | none | `features/accounts/qr-view-model.ts` | add provider table test | 2 |
| `providerLabelText` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrInstructionForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrScannedTextForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `loginTitleForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `loginDescriptionForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrLoadingMarkForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `cookiePlaceholderForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `HomeListenHistoryRecord` | interface | pure | none | `features/home/listen-history.ts` | listen history tests | 7 |
| `HomeListenSession` | interface | pure | none | `features/home/listen-history.ts` | listen session tests | 7 |
| `DESKTOP_LYRIC_FONT_STACKS` | constant | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop style tests | 2 |
| `normalizeDesktopLyricFontKey` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopLyricFontStackForKey` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopLyricFontWeightValue` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopOverlayColorValue` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `trackTitle` | function | pure | none | `features/playback/track-view-model.ts` | add table test | 2 |
| `trackArtist` | function | pure | none | `features/playback/track-view-model.ts` | add table test | 2 |
| `trackLikeKey` | function | pure | none | `features/likes/like-key.ts` | likes tests | 2 |
| `trackProviderLikeId` | function | pure | none | `features/likes/like-key.ts` | likes tests | 2 |
| `updateHomeListenHistory` | function | pure | none | `features/home/listen-history.ts` | listen history tests | 3 |
| `readHomeListenHistory` | function | browser-storage | reads localStorage | `adapters/storage/browser-preferences.ts` | migration tests later | 7 |
| `writeHomeListenHistory` | function | browser-storage | writes localStorage | `adapters/storage/browser-preferences.ts` | migration tests later | 7 |
| `beginHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `updateHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `isEffectiveHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `buildHomeListenSummary` | function | pure | none | `features/home/listen-history.ts` | summary tests | 3 |
| `isProviderLikeSupported` | function | pure | none | `features/likes/like-policy.ts` | likes tests | 2 |
| `isNeteaseLikeSupported` | function | pure | none | `features/likes/like-policy.ts` | existing App export tests | 2 |
| `isCollectSupportedTrack` | function | pure | none | `features/library/collect-policy.ts` | existing App export tests | 2 |
| `likeUnsupportedMessage` | function | pure | none | `features/likes/like-policy.ts` | copy tests | 2 |
| `collectUnsupportedMessage` | function | pure | none | `features/library/collect-policy.ts` | copy tests | 2 |
| `isLoginRequiredError` | function | pure | none | `features/accounts/account-error-policy.ts` | ApiError tests | 2 |
| `trialBannerText` | function | pure | none | `features/playback/playback-view-model.ts` | trial tests | 2 |
| `toJsonValue` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | desktop payload tests | 2 |
| `isPodcastTrack` | function | pure | none | `features/playback/track-policy.ts` | podcast tests | 2 |
| `beatMapArrayLength` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `beatMapNumber` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `beatMapString` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `desktopLyricsBeatMapKey` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | existing App export tests | 2 |
| `desktopLyricsBeatMapContext` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `buildDesktopLyricsPayloadPatch` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | existing App export tests | 2 |
| `isHomeBlankDismissElement` | function | DOM | inspects event target | `features/home/home-surface-policy.ts` | existing App export tests | 3 |
| `EmptyHomeStateInput` | interface | pure | none | `features/home/home-surface-policy.ts` | home tests | 3 |
| `shouldShowEmptyHome` | function | pure | none | `features/home/home-surface-policy.ts` | existing App export tests | 3 |
| `deriveSidecarRecoveryNoticeState` | function | pure | none | `app/runtime/sidecar-recovery-policy.ts` | existing App export tests | 1 |
| `nextSidecarStatusPollDelayMs` | function | pure | none | `app/runtime/sidecar-recovery-policy.ts` | existing App export tests | 1 |
| `isDesktopWindowFullscreen` | function | pure | none | `features/desktop/window-state.ts` | existing App export tests | 2 |
| `forceBottomControlsVisible` | function | DOM | dispatches pointer/UI state | `app/runtime/GlobalShellRuntime.tsx` | App UI tests | 8 |
| `applyDesktopWindowShellState` | function | DOM | changes document classes | `features/desktop/window-shell.ts` | existing App export tests | 5 |
| `DesktopTitlebar` | component | React-runtime | renders window chrome | `features/desktop/DesktopTitlebar.tsx` | App DOM tests | 8 |
| `shouldUseSecondaryLeftDisplaySeamGuard` | function | pure | none | `features/desktop/window-state.ts` | existing App export tests | 2 |
| `AppProps` | type | pure | none | `app/App.tsx` | test injection contract | 10 |
| `DesktopLyricsRuntime` | type | pure | none | `ports/desktop-runtime-port.ts` | desktop adapter tests | 2 |
| `defaultDesktopLyricsRuntime` | constant | Tauri | binds Tauri wrappers | `adapters/tauri/tauri-desktop-runtime.ts` | runtime tests | 5 |
| `createDefaultSidecarClient` | function | sidecar | constructs concrete client | `adapters/sidecar/legacy-sidecar-services.ts` | client tests | 1 |
| `App` | component | React-runtime | owns all current domains | composition-only `app/App.tsx` | 4004-line characterization suite | 10 |

## 提取纪律

1. 先移动有现有证据的纯函数，并从旧路径临时 re-export；
2. browser storage、DOM、Tauri 和 sidecar 符号先建立 Port/Adapter；
3. 每次只移动一个 runtime/effect 所有权；
4. 不创建全能 `useAppController`；
5. `App.tsx` 行数不是单独门禁，依赖方向和 characterization tests 才是门禁。
