# Third-party Notices

MineRadio-Tauri combines GPL-3.0-only original core code with separately licensed third-party material. This file summarizes the main third-party software, services, assets, and separately licensed visual material used by the project. Exact dependency versions are defined by `bun.lock`, `package.json`, and `apps/desktop/src-tauri/Cargo.lock`; separately licensed material remains subject to the terms stated below.

## Project License

| Item | License | Use |
| --- | --- | --- |
| MineRadio-Tauri original code | GPL-3.0-only | Application source code, build scripts, and project documentation, except separately identified third-party material. |

## Desktop And Build Stack

| Item | License | Use |
| --- | --- | --- |
| Tauri 2 | MIT / Apache-2.0 | Desktop shell, window management, commands, updater, and sidecar lifecycle. |
| Rust crates used by the Tauri app | See `apps/desktop/src-tauri/Cargo.lock` | Serialization, filesystem paths, time handling, build integration, and Tauri plugins. |
| Bun | MIT | Workspace package manager, script runner, tests, and sidecar runtime. |
| Vite | MIT | Web app development and production build. |
| TypeScript | Apache-2.0 | Type checking for the web app, shared package, visual engine, and sidecar. |

## Web And Runtime Stack

| Item | License | Use |
| --- | --- | --- |
| React / React DOM | MIT | Frontend UI rendering. |
| Zustand | MIT | Frontend state management. |
| zod | MIT | Shared runtime schemas and API payload validation. |
| Three.js | MIT | WebGL scenes and 3D visual effects. |
| GSAP | Standard no-charge license | Animation timing and visual motion. |
| happy-dom | MIT | DOM-like test environment. |

## Sonic Topography Visual Origin

| Item | License | Use |
| --- | --- | --- |
| Sonic Topography visual algorithm | Non-Commercial Learning License | Preset 7 terrain, frequency response, floating blocks, ripples, meteors, and trails; intended for learning, research, and personal non-commercial use. |

MineRadio-Tauri preserves the following source chain:

```text
XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224
  public/sonic-topography-preset.js
    -> yin-yizhen/sonic-topography@3ff303e
       Sonic Topography 1.1.1
       作者：Ajin
```

The Mineradio source file states that its visual algorithm was ported from `yin-yizhen/sonic-topography` 1.1.1. The project maintainer has also reviewed public collaboration evidence supplied by the user, in which the Mineradio author described the work as “与音域回响作者 Ajin 联动”. This 公开合作证据 informed a 维护者项目决策 and is recorded in `docs/parity/sonic-origin-decision.md`. It is provenance evidence only and 不等于书面授权, relicensing, waiver, or a grant of additional redistribution or sublicensing rights.

The Tauri adaptation is a modified integration and must not be represented as an unmodified release by Ajin or the Sonic Topography contributors. Copyright, license, attribution, and personal non-commercial notices（个人非商业告知）must be retained.

### Non-Commercial Learning License

```text
Non-Commercial Learning License

Copyright (c) 2026 Sonic Topography contributors

This project is provided only for learning, research, and personal non-commercial use.

You may:
- read, study, and modify the source code for learning;
- run the project locally for personal non-commercial use;
- share non-commercial study notes or screenshots with attribution.

You may not, without explicit written permission from the copyright holder:
- use this project or derived works for commercial projects;
- use it for commercial performances, commercial exhibitions, paid services, resale, advertising services, or other profit-making activities;
- sell, sublicense, rent, or package it as a paid product;
- remove copyright, license, or non-commercial notices.

This project is provided "as is", without warranty of any kind. The copyright holder is not liable for any claims, damages, or other liability arising from use of the project.
```

## Model And Provider Dependencies

| Item | License | Use |
| --- | --- | --- |
| @xenova/transformers | Apache-2.0 | Local model runtime for depth-related visual effects. |
| Xenova/depth-anything-small-hf | Apache-2.0 | Local depth model used by visual features. |
| hana-music-api | MIT | Netease provider integration. |
| NeteaseCloudMusicApi fallback | ISC | Netease provider fallback path. |
| qq-music-api (`jsososo/QQMusicApi`) | GPL-3.0 | QQ Music provider integration. |

## Service Disclaimer

MineRadio-Tauri is not an official client of NetEase Cloud Music, QQ Music, Tencent Music Entertainment, or any other music platform.

Third-party platform integration is intended for personal learning, local desktop use, and playback assistance for accounts controlled by the user. Users and contributors should follow the terms, copyright rules, and membership rules of the relevant platforms. The project must not include code or documentation that bypasses payment, membership restrictions, audio quality restrictions, or content redistribution limits.
