# Third-party source notices

## Historical Ogesture derivation

Earlier Launcher Probe versions incorporated modified source from **Ogesture**, by the Ogesture contributors / team Olauncher:

- Repository: https://github.com/tanujnotes/Ogesture
- Exact revision: `404fb0a27a5e3122b153a4a97a150f31c3c04804`
- License: GNU Affero General Public License version 3, copied verbatim from upstream into [`LICENSE`](LICENSE).
- Original modification date: 2026-09-09. This application remains distributed under AGPL-3.0; it is not an official Ogesture release.

The standalone-assistant migration removes the derived `SwipeDetector.java` and `GestureService.java`, including the fixed navigation zones, accessibility overlays and touch replay. The former mappings were `gesture/SwipeDetector.kt` / `data/Models.kt` to `SwipeDetector.java`, and `service/EdgeOverlayService.kt` / `service/EdgeGestureAccessibilityService.kt` to `GestureService.java`. These are historical attributions, not a statement that the current APK includes that gesture implementation.

The project-added `NavigationSession.java` and accessibility configuration are also removed. `LegacySystemCleanup` is project migration code: only a retained pending-restore marker permits writing and verifying the old stop value (`force_fsg_nav_bar=0`). It neither recreates navigation gestures nor enables accessibility services. The project license and historical attribution are retained; no license file is deleted by this migration.

## Operit Shower

The application incorporates and modifies **Operit Shower**, by the Operit contributors:

- Repository: https://github.com/AAswordman/Operit
- Exact revision: `b2c76100e5960a82ec154b62f201d89db099fadc`
- Upstream paths: `showerclient/` and `tools/shower/app/src/main/`
- License: GNU Lesser General Public License version 3; a verbatim copy is retained at [`licenses/Operit-LGPL-3.0.txt`](licenses/Operit-LGPL-3.0.txt).

The required corresponding source is kept in this repository rather than represented only by a prebuilt upstream artifact:

| Upstream source | Local source | Changes |
| --- | --- | --- |
| `showerclient/.../ShowerController.kt`, `ShowerBinderRegistry.kt` | `app/src/main/java/com/example/launcherprobe/ShowerController.java`, `ShowerManager.java` | Java host integration using the existing Shizuku permission channel and one controller-owned virtual display. Adds authenticated Binder handoff, strict coordinates, real error propagation and explicit release. |
| `showerclient/.../ShowerServerManager.kt` | `OwnPermissionService.java`, `ShowerManager.java` | Replaces `/sdcard/Download/Operit`, broad `pkill`, Kotlin coroutines and a separate permission framework. The existing UID-checked UserService copies the generated asset directly to an app-owned `/data/local/tmp/e-launcher-shower-<uid>` directory, tracks and stops only its validated PID, and waits asynchronously for Binder handoff. |
| `showerclient/.../IShowerService.java`, `ShowerBinderContainer.java` | `app/src/main/aidl/com/ai/assistance/shower/IShowerService.aidl`, `app/src/main/java/com/ai/assistance/shower/ShowerBinderContainer.java` | Equivalent Binder contract converted to AIDL and narrowed to used functions. Screenshots use `ParcelFileDescriptor` instead of Binder byte arrays. The parcelable container and broadcast action/key stay protocol-compatible. |
| `tools/shower/app/src/main/java/com/ai/assistance/shower/` | `shower-server/src/main/` | Binder-only server with no Compose/video UI dependencies. Keeps Operit's virtual-display, capture, hidden-API workaround and display-scoped input implementation; enforces the host UID, forbids display 0, owns only one display, scales captures before PNG encoding, returns screenshot pipes, reports launch/input failures, sends swipe events at their actual timestamps, checks per-call Binder cancellation between gesture events, and exits only when no display is active. |
| `showerclient/src/main/assets/shower-server.jar` | `shower-server/build.gradle`, `app/build.gradle` | The 1.08 MiB upstream prebuilt artifact is not copied. Gradle reproducibly builds the modified, source-present server APK and packages it under the expected `shower-server.jar` asset name. |

The application uses the source-present Binder-only Shower server and a native `TextureView` overlay; no upstream video UI or scrcpy code is bundled.

Network requests use [OkHttp 3.14.9](https://github.com/square/okhttp/tree/parent-3.14.9), Copyright 2019 Square, Inc., under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

The selected upstream source files contain no individual copyright headers. Attribution for retained derived sources is kept here and at their Java file headers; historical removed-source mappings are documented above; the Free Software Foundation copyright in the license text refers to that document, not authorship of Ogesture's code. No upstream license notice has been removed.

## China mainland holiday arrangements

The APK includes a transformed, manually verified **2026** snapshot from
[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn), pinned to
commit `dcecbce230a57639cc8967ec9e2465e744880fd8` (2025-11-04).
Copyright (c) 2019 NateScarlet; MIT license retained verbatim in
[`app/src/main/assets/cn-holidays-LICENSE.txt`](app/src/main/assets/cn-holidays-LICENSE.txt).
The snapshot retains the source commit, annual coverage, actual dates (including
adjacent-year entries), and the State Council notice:
https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm .
Only the verified annual coverage is treated as official; empty future-year
placeholders are rejected. Unlisted dates use ordinary weekdays/weekends, while
listed holiday and makeup-work dates override them. This is scheduling of all
days off, not a wage-multiplier or statutory festival-day calculation.

The Host reads the bundled verified snapshot and reports fallback for uncovered years.

## Bundled npm

The APK includes the official npm 11.6.2 distribution, installed from the pinned
`host-core/package-lock.json` and copied into the Host assets. npm uses the
Artistic License 2.0; its license and bundled dependency notices accompany the
distribution. Source: https://github.com/npm/cli/tree/v11.6.2.

## Distribution

When conveying this APK, satisfy AGPLv3's corresponding-source requirements, including these modifications and the material needed to build them. A link to the unmodified upstream repository alone is not corresponding source for this APK. Preserve this notice and the complete license; consult `LICENSE` for the applicable source-delivery options and the network-interaction provisions if functionality later changes. This project makes no warranty of compatibility with a particular ROM.

## acp-kernel

The managed Billion Context Host plugin uses **acp-kernel 0.0.101**, by ranxianglei,
for in-context compression. New Host and Android Host runtime bundles do not embed
the plugin or acp-kernel; the separately distributed plugin README carries the full
license and attribution, and the managed installation supplies its dependency.

- Repository: https://github.com/ranxianglei/acp-kernel
- License: MIT, with the upstream "Attribution on Product Surfaces" additional
  term; the full text is retained verbatim at
  [`licenses/acp-kernel-MIT.txt`](licenses/acp-kernel-MIT.txt).

That additional term requires visible attribution on at least one of the
product's home page, documentation, or About/Credits/Acknowledgements page,
stating the product uses acp-kernel and linking to
https://github.com/ranxianglei/acp-kernel. For server-side or embedded uses
without a user-facing surface, carrying these notices in the shipped
documentation satisfies the term.

## ripgrep and fd (search tools)

The host-core installs pinned **ripgrep 15.1.0** (<https://github.com/BurntSushi/ripgrep>) and
**fd 10.3.0** (<https://github.com/sharkdp/fd>) into the host dataRoot to back the grep/find
tools. Both projects offer their software under the MIT License (ripgrep additionally offers the
Unlicense); host-core selects and preserves each project's MIT license. The upstream license texts
are not copied into this repository: `host-core/prepare-tools.js` extracts each official release
archive's `LICENSE-MIT` entry at install time and saves it beside the installed binary at
`<dataRoot>/tools/<platform>-<arch>/<name>-<version>/LICENSE-MIT`, so the exact upstream notice
accompanies the downloaded artifact. Binaries are fetched from the projects' official GitHub release
assets at pinned tags (`15.1.0`, `v10.3.0`), checked against PE/ELF headers, and installed with
atomic rename; installation results report sha256 fingerprints. Only Windows x64 has been exercised
so far.

For the Android Host, the same pinned source versions are built from their locked Cargo
crates (ripgrep 15.1.0 from crates.io sha256
`f388c4955f85477c28a8667355819844a06614b083c23517f0e86bd1d6d82b73`; fd-find 10.3.0
from crates.io sha256
`2fbf004b5bbdefab92e76237e2022c77842cdef5d3213fe09fd804e0474785db`) for the Android
NDK targets `aarch64-linux-android` (arm64-v8a) and `x86_64-linux-android` (x86_64), with
API 29 and 16KiB ELF page alignment, and packaged into the APK as jniLibs
`libhost_rg.so`/`libhost_fd.so` (ELF executables renamed for Android packaging/extraction, generated
by `host-core/prepare-android-tools.js`). fd is built with `--no-default-features` to avoid
jemalloc and shell-completion extras. Linux-musl release binaries are not used on Android
because they fail under the real app UID (exit 159). The upstream MIT notices of rg and fd are
copied from the verified source crates into `bot-host/third-party-licenses.txt`.

## Android Host runtime bundle

The APK's host runtime (`bot-host/host-runtime.mjs`) bundles `@earendil-works/chord`,
`@earendil-works/pi-ai` and `@earendil-works/pi-durable` at version **1.3.0**,
together with the transitive dependencies actually included
in the bundle. Each included package's name, version and license text are emitted
at build time into the shipped `bot-host/third-party-licenses.txt` by
`host-core/build-android.js`; exact versions are pinned in
`host-core/package-lock.json`. Building the bundle uses the root Vite installation's esbuild; esbuild itself is not shipped. The host runtime is built from
the repository's own `host-core` sources, not from a third-party binary kit.

The published npm archives of `@earendil-works/chord`, `@earendil-works/pi-ai`
and `@earendil-works/pi-durable` at 1.3.0 do not include a LICENSE file, so
`host-core/build-android.js` uses the pinned in-repo upstream copy
[`licenses/pi-v1.3.0-MIT.txt`](licenses/pi-v1.3.0-MIT.txt) for these three
packages when their installed package lacks a license file. That copy is the
verbatim MIT license of the earendil-works/pi repository at tag `v1.3.0`
(https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/LICENSE, Copyright
(c) 2025 Mario Zechner), verified by the project reviewer; it covers all three
packages, which are published from the same upstream repository. Any other
bundled package without a license file still fails the build instead of
falling back to package metadata.

## Center platform dependencies and Pi Skill adaptation

The center's independent npm installation roots are `center-server` and
`center-web`; the existing relay uses `host-core`. Their exact installed
versions and transitive dependency metadata are recorded in their respective
lockfiles. The image retains those installed packages and their accompanying
license/notice files under each root's `node_modules`; it also includes this
notice, `LICENSE`, and `licenses/`. Build-only center-web dependencies are
retained to preserve their notices. Runtime managed packages installed by a
user are separate artifacts and retain their own license obligations.

The center uses Fastify and its official plugins (MIT), Ajv (MIT), deepmerge
4.3.1 (MIT), pacote (ISC), semver (ISC), npm 11.6.2 (Artistic License 2.0),
and React JSON Schema Form 6.11.0 (Apache-2.0). React and the existing
frontend libraries remain subject to their own included notices. Package
versions and transitive licenses must be reviewed against the generated
lockfiles and installed distributions before release; candidate versions are
not proof of compatibility or of the completeness of those notices.

`host-core/third-party/pi-skills.js` adapts
`dist/core/skills.js` and `dist/utils/frontmatter.js` from the published
`@earendil-works/pi-coding-agent` 1.3.0 archive, corresponding to tag
`v1.3.0` (https://github.com/earendil-works/pi/tree/v1.3.0). The archive SHA-256 is
`ae2785e870b81a8c8e1d44510a57b5ee0bfc9e974679ac2faaada4aabee3d3c0`.
The adaptation is restricted to managed directories rather than Pi's
HOME/project scanning. Pi is Copyright (c) 2025 Mario Zechner, MIT;
the full upstream text is retained in
[`licenses/pi-v1.3.0-MIT.txt`](licenses/pi-v1.3.0-MIT.txt).
The same license applies to `@earendil-works/pi-mcp` 1.3.0; the Android
and desktop packagers use that exact-version fallback if its archive has no
license file. These attributions do not alter this project's AGPL-3.0 license.

The desktop application runs a client broker, not a Host, and does not package
another npm distribution. Android reuses the versioned npm asset described
above. An independent Node Host can use its locked npm 11.6.2 dependency, whose
Artistic-2.0 license and bundled dependency notices accompany that distribution.
The Host's `tar` 7.5.22 is by Isaac Z. Schlueter and contributors,
under the Blue Oak Model License 1.0.0; its full text is retained in
[`licenses/tar-7.5.22-BlueOak-1.0.0.md`](licenses/tar-7.5.22-BlueOak-1.0.0.md).
Bundled Host dependency notices are collected from the actual esbuild inputs.

## ws (WebSocket)

The host-core depends on **ws 8.22.0**, the WebSocket client/server implementation for Node.js, under the MIT License:

- Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
- Copyright (c) 2013 Arnout Kazemier and contributors
- Copyright (c) 2016 Luigi Pinca and contributors

The full verbatim license is retained at [`licenses/ws-MIT.txt`](licenses/ws-MIT.txt). Source: https://github.com/websockets/ws

## Hindsight client SDK

The host-core depends on **@vectorize-io/hindsight-client 0.9.2**, the generated client for the Hindsight memory service, under the MIT License:

- Copyright (c) 2025 Vectorize AI, Inc.
- Exact npm version and registry integrity are pinned in [`host-core/package-lock.json`](host-core/package-lock.json); the npm registry records the package `gitHead` `ebad478240d3171bb88201ececda5e8d9883d22d` for 0.9.2.
- The full verbatim license is retained at [`licenses/hindsight-client-0.9.2-MIT.txt`](licenses/hindsight-client-0.9.2-MIT.txt).

The published 0.9.2 archive contains only generated `dist` sources and no LICENSE file, so `host-core/build-android.js` and `host-core/build-desktop.js` use the pinned in-repo MIT copy above when packaging this exact version, and fail the build for any other version without a license file. This notice describes the bundled SDK only; the Hindsight service itself is not part of this repository or the APK.

## Tauri Android UI (`:tauri_ui`, module 18)

The APK now also ships a second UI process built from this repository's own frontend
plus the pinned Tauri Android stack:

- **Rust**: `tauri` **2.12.5** and `wry` **0.57.0** (both Apache-2.0 OR MIT) with
  `tauri-build` **2.7.4** as build dependency, pinned in
  [`mobile/src-tauri/Cargo.toml`](mobile/src-tauri/Cargo.toml). The cdylib
  `libe_launcher_mobile.so` (crate `e-launcher-mobile`) and the wry/tauri Kotlin that
  their build scripts generate at compile time (`Rust.kt`, `WryActivity.kt`,
  `TauriActivity.kt`, ...) are compiled into app id `com.example.launcherprobe`. Their
  license texts come from whatever license files the crate archives contain, plus the
  explicit exact-version fallbacks listed below.
- **Kotlin runtime**: shipped through the Kotlin Gradle plugin 2.3.20
  (`kotlin-stdlib`, Apache-2.0).
- **AndroidX/JVM libraries added for the UI process**: `androidx.startup:startup-runtime`
  **1.2.0**, `androidx.lifecycle:lifecycle-process` **2.10.0**,
  `androidx.webkit:webkit` **1.12.0** and
  `com.fasterxml.jackson.core:jackson-databind` **2.15.3** (Apache-2.0).

Legal texts shipped inside dependency jars are handled by AGP's standard packaging
merge: `app/build.gradle` removes only the eight default-excluded paths
`/META-INF/LICENSE`, `/META-INF/LICENSE.txt`, `/META-INF/NOTICE`,
`/META-INF/NOTICE.txt`, `/LICENSE`, `/LICENSE.txt`, `/NOTICE`, `/NOTICE.txt` from
`android.packaging.resources.excludes` and adds the same paths to
`resources.merges`, so same-named files are concatenated instead of dropped. The
signature/MANIFEST default exclusions and `jniLibs.useLegacyPackaging` are untouched;
there is no `pickFirst` and no hand-written replacement text.

Scoped verification of that wiring: after deleting the generated SDK include, a full
dual-ABI `assembleDebug` + `assembleDebugAndroidTest` finished with exit 0 and the
include was regenerated byte-identically. The resulting APK adds only
`META-INF/LICENSE`, `META-INF/LICENSE.txt` and `META-INF/NOTICE`; every other entry of
the previously accepted APK (DEX, native libraries, all assets and resources) is
SHA-256 identical in a single-pass extraction in the same ZIP order. All eight
`META-INF/LICENSE`/`NOTICE` files from the four Jackson 2.15.3 dependencies are
present as full texts inside the merged entries, and zipalign `-P16` plus the original
signing pass. Remote GitHub Actions has still not been run, and this verification does
not cover it.

`host-core/build-mobile.js` writes the Rust dependency notices for the ABI cargo graph
actually built into the Gradle assets source root
`app/build/generated/assets/tauri/THIRD_PARTY_NOTICES.txt`; inside the APK that file is
the asset `THIRD_PARTY_NOTICES.txt` (there is no `tauri/` asset directory). It reuses
the exact-version fallbacks of `host-core/build-desktop.js`, including mappings that
already existed for the desktop graph (`alloc-stdlib@0.3.0`, `selectors@0.38.0`). Four
published crate archives in the Android graph omit a license file, so their declared
license texts are vendored verbatim in this repository:

| crate | declared license | vendored texts | provenance |
| --- | --- | --- | --- |
| `jni-sys-macros` 0.4.1 | MIT OR Apache-2.0 | `licenses/android/jni-sys-macros-0.4.1-MIT.txt`, `licenses/android/jni-sys-macros-0.4.1-Apache-2.0.txt` | `jni-rs/jni-sys` commit `64d77b7a5f119d7b55b4e2c169a4668067ff59e6`, crate `jni-sys-macros`; version and declaration proven by the published crate's `Cargo.toml` and `.cargo_vcs_info` |
| `ndk-context` 0.1.1 | MIT OR Apache-2.0 | `licenses/android/ndk-context-0.1.1-MIT.txt`, `licenses/android/ndk-context-0.1.1-Apache-2.0.txt` | `rust-windowing/android-ndk-rs` commit `10f2ba388fca20f7349996ebae26ccda7a6fda5c`, path `ndk-context`; version and declaration taken from the published crate's `Cargo.toml.orig` and `.cargo_vcs_info` (the remote manifest fetch failed, so no remote manifest was used) |
| `ndk` 0.9.0 | MIT OR Apache-2.0 | `licenses/android/ndk-49bbbba16c58-MIT.txt`, `licenses/android/ndk-49bbbba16c58-Apache-2.0.txt` | `rust-mobile/ndk` commit `49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25`, path `ndk`; repository root `LICENSE-MIT`/`LICENSE-APACHE` at that commit |
| `ndk-sys` 0.6.0+11769913 | MIT OR Apache-2.0 | the same two `ndk-49bbbba16c58-*` files through an explicit mapping | `rust-mobile/ndk` commit `49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25`, path `ndk-sys`; the workspace inherits the repository root declaration, so the entry maps explicitly to the same verified root texts (not a sibling or version-range fallback) |

The `jni-sys-macros` MIT text starts with `Copyright (c) 2015 The rust-jni-sys
Developers`. The MIT texts taken for `ndk`/`ndk-sys`/`ndk-context` from the repository
root contain no copyright line, and none was invented for them. The Apache text keeps
terms 1-9 and the APPENDIX. A bundled crate whose archive has no license file and that
has no exact fallback mapping still fails the build instead of falling back to package
metadata.
