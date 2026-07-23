# Credits & Third-Party Licenses

This project's own source code is licensed under the MIT License (see `LICENSE`).
The bundled assets and dependencies below carry their **own** licenses.

## Default 3D model

The default avatar (`activity/public/models/sample.vrm`) is **not committed to
this repository**. It is downloaded at setup time by
`scripts/fetch-sample-model.sh` from pixiv's official three-vrm examples:

- Name: `VRM1_Constraint_Twist_Sample`
- Copyright: **© 2022 pixiv Inc.**
- License: **VRM 1.0 Public License** — <https://vrm.dev/licenses/1.0/>
- Source: <https://github.com/pixiv/three-vrm> (`packages/three-vrm/examples/models/`)
- Permissions embedded in the model metadata:
  redistribution allowed · modification + redistribution allowed ·
  commercial use (corporation) allowed · avatar use by everyone ·
  credit notation unnecessary (given here anyway, for accuracy).

This is pixiv's official VRM 1.0 sample model, used as a placeholder. It is
**not** covered by this repository's MIT license. Swap in your own VRM by
replacing the file and re-framing the camera via the dev admin panel
(open the Activity with `?admin` in the URL).

## Vendored code

Two files under `activity/src/` are copied from pixiv's official three-vrm
examples (`humanoidAnimation`), MIT-licensed, (c) pixiv Inc.:

- `loadMixamoAnimation.js` — Mixamo FBX → VRM humanoid retargeting
- `mixamoVRMRigMap.js` — Mixamo rig name → VRM bone name map

Source: <https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/humanoidAnimation>

## Motion clips (Mixamo)

Idle/speaking/thinking animations are **not included** in this repository and
are gitignored on purpose: [Adobe Mixamo](https://www.mixamo.com)'s license
permits using clips in your projects but **not redistributing the raw files**.
Download clips yourself and place them under `activity/public/models/anim/`
(naming rules in the `README.txt` there). Without them the avatar falls back
to built-in poses.

## Runtime dependencies

Backend (`bot/`):
- [discord.js](https://github.com/discordjs/discord.js) — Apache-2.0
- [ws](https://github.com/websockets/ws) — MIT

Frontend (`activity/`):
- [three.js](https://github.com/mrdoob/three.js) — MIT
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — MIT
- [@discord/embedded-app-sdk](https://github.com/discord/embedded-app-sdk) — MIT
- [vite](https://github.com/vitejs/vite) — MIT (dev)

## TTS engine

- [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine)
  (Style-Bert-VITS2) — the emotional TTS engine, pulled as a container image
  (`ghcr.io/aivis-project/aivisspeech-engine`). See its repository for
  licensing. Voice models downloaded by the engine carry their own terms —
  review them before commercial use.

Each dependency's full license text ships inside its own package under
`node_modules/` after `npm install`.
