# Orca browser modules

## Screencast

These modules are from stablyai/orca v1.4.267 at commit `baf9c2c328fa95c0ba9c25fda4836b479162d232`. See [LICENSE](LICENSE) for the MIT license and copyright notice.

The TypeScript modules are transpiled to ES modules for both desktop and embedded Host runtimes. The frame codec imports the original JSON limit validator through a relative JavaScript path. The Center relay envelope, authentication and browser session adapters live outside this directory.

| Source at the upstream commit | SHA-256 of upstream source |
| --- | --- |
| `src/shared/browser/screencast/browser-screencast-protocol.ts` | `23f019b86aba7b0a3cce64882c2f09ca96ffda8a6acc8f9bb0e07c9aa689c0d5` |
| `src/main/runtime/browser/screencast/browser-screencast-frame-credit.ts` | `30dc1bb74a32e0b07a9dd4e4a9b66118bc8970b75f3761d88bcdbc0d177ed567` |
| `src/shared/json-stream/json-text-structure-limit.ts` | `3a3508fd11c5ec5e6b802cdaf44dfa903fe3da825ea2450d760346bae3c1b839` |
| `LICENSE` | `ff1b611f80580d49f4b97e93a97b24eb050b0671b26b8afe16341fab699112f3` |

## Chromium startup

The following helpers come from Orca v1.4.265 at commit `e64e561738d8d465ab459e7e3f9e46d08b6396ea` and were transpiled to JavaScript. The Snap helper accepts the existing Pi Bot profile path and preserves the `pibot-browser-` directory prefix.

| Source at the upstream commit | SHA-256 of upstream source |
| --- | --- |
| `src/main/browser/agent-browser/helper-process/agent-browser-user-settings-isolation.ts` | `915f19cb47cf61f587a2f6b8d4a32aa7e1b474a343be1b1e5771dac435526424` |
| `src/main/orcad/browser-providers/chromium/external-chromium-profile-path.ts` | `6437e40725b760009aca7cea8d4cb1e5c80c836f913ffd1e61ce25e5e5d5aef6` |
| `src/main/orcad/browser-providers/chromium/external-chromium-browser-session.ts` (`unwritableProfileLockLine`) | `18d3a3cb05479cfb6b284da04273daec418eb51865d8ac0ef3427e5a0b2d4306` |
