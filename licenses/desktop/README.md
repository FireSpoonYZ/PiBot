# Desktop client vendored license texts

These files back the third-party notices for Rust dependencies whose published
crate archives do not include a license file, plus two npm UI packages
(`remark-math`, `rehype-katex`) whose published archives likewise omit one. Each file is copied verbatim from
the upstream source listed below (note: extraction/retrieval may normalize
formatting such as line endings, and the saved text hash identifies the saved
text, not the original raw HTTP bytes). No copyright notice or text was added,
removed, or rewritten.

| File | Package | Version | License | Upstream source |
| --- | --- | --- | --- | --- |
| `alloc-stdlib-0.3.0-BSD-3-Clause.txt` | alloc-stdlib | 0.3.0 | BSD-3-Clause | https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE |
| `dlopen2-MIT.txt` | dlopen2 | 0.8.2 | MIT | https://raw.githubusercontent.com/OpenByteDev/dlopen2/cc80e4a0a90d499b677fdf7743699b4b3a43a989/LICENSE |
| `dlopen2-MIT.txt` | dlopen2_derive | 0.4.3 | MIT | same commit and text as dlopen2 (cc80e4a0a90d499b677fdf7743699b4b3a43a989), shared file |
| `libappindicator-sys-0.9.0-MIT.txt` | libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT | https://raw.githubusercontent.com/tauri-apps/libappindicator-rs/eafd1e3682a1247f595410266091e9684021cb6f/LICENSE-MIT (crate lives in the `sys` path of that commit) |
| `libappindicator-sys-0.9.0-Apache-2.0.txt` | libappindicator-sys | 0.9.0 | Apache-2.0 | https://raw.githubusercontent.com/tauri-apps/libappindicator-rs/eafd1e3682a1247f595410266091e9684021cb6f/LICENSE-APACHE |
| `selectors-0.38.0-MPL-2.0.txt` | selectors | 0.38.0 | MPL-2.0 | Mozilla official MPL 2.0 text (https://www.mozilla.org/MPL/2.0/), explicitly linked by the installed selectors 0.38.0 `lib.rs` header (lines 1-3) |
| `tauri-plugin-2.7.2-MIT.txt` | tauri-plugin | 2.7.2 | MIT | https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/LICENSE-MIT |
| `tauri-plugin-2.7.2-Apache-2.0.txt` | tauri-plugin | 2.7.2 | Apache-2.0 | https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/LICENSE-APACHE-2.0 |
| `webview2-rs-MIT.txt` | webview2-com | 0.39.1 | MIT | https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE |
| `webview2-rs-MIT.txt` | webview2-com-sys | 0.39.1 | MIT | same commit as webview2-com (edc2caf886175ccaebe86078c9cfe1ae2a187328) |
| `webview2-rs-MIT.txt` | webview2-com-macros | 0.8.1 | MIT | https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE (text identical to the webview2-com commit, shared file) |
| `remark-math-6.0.0-MIT.txt` | remark-math | 6.0.0 | MIT | https://raw.githubusercontent.com/remarkjs/remark-math/main/license (monorepo root license; npm archive ships none) |
| `rehype-katex-7.0.1-MIT.txt` | rehype-katex | 7.0.1 | MIT | same remarkjs/remark-math monorepo license text (verbatim copy) |
| `aws-sdk-js-v3-Apache-2.0.txt` | @aws-sdk/credential-provider-http, @aws-sdk/credential-provider-login, @aws-sdk/nested-clients | 3.972.77, 3.972.82, 3.997.49 | Apache-2.0 | aws/aws-sdk-js-v3 monorepo root `LICENSE` (copied verbatim from sibling `@aws-sdk/client-bedrock-runtime/LICENSE`) |
| `data-uri-to-buffer-4.0.1-MIT.txt` | data-uri-to-buffer | 4.0.1 | MIT | `License` section embedded in `data-uri-to-buffer@4.0.1/README.md` |
| `proxy-agents-MIT.txt` | proxy-agent-negotiate | 1.1.0 | MIT | TooTallNate/proxy-agents monorepo root `LICENSE` (copied verbatim from sibling `https-proxy-agent/LICENSE`) |
| `objc2-LICENSE.md` | block2, objc2, objc2-encode, objc2-foundation (MIT); dispatch2, objc2-exception-helper, objc2-app-kit, objc2-core-foundation, objc2-core-graphics, objc2-io-surface, objc2-osa-kit, objc2-quartz-core, objc2-web-kit (Zlib OR Apache-2.0 OR MIT) | 0.6.2, 0.6.5, 4.1.0, 0.3.2; 0.3.1, 0.1.1, 0.3.2 | see package column | https://raw.githubusercontent.com/madsmtm/objc2/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md — byte-identical (SHA-256 `7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54`) at every source commit recorded in the crates' `.cargo_vcs_info.json` (b4167b5, d7d2fa2, 8d214f5, 8852b42, 7b1abfd) |
| `spdx-MIT.txt` | the objc2 crates above (used under MIT) | — | MIT | https://raw.githubusercontent.com/spdx/license-list-data/v3.29.0/text/MIT.txt (SHA-256 `b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5`); the objc2 `LICENSE.md` is a licensing statement without an MIT text or copyright line, so the standard text is included alongside it |

`plist@1.10.3` is not vendored: its crate archive contains a top-level
`LICENCE` file, which the packaging script discovers directly via the
`licence` name prefix.

The `dlopen2`, `dlopen2_derive` and `libappindicator-sys` entries come from the
Linux x64 dependency set (discovered while packaging on Linux) whose crate
archives ship no license file; they are exact package@version entries, so they
do not affect the Windows dependency set. Listing them here is a packaging
statement only, not evidence that the Linux client was built or launched.

The objc2-family entries come from the macOS arm64 dependency set (Tauri/wry
and the `ctrlc` dependency of `pibot-host`); `build-desktop.js` records the
exact upstream commit and crate path of each crate in the generated notices.

`build-desktop.js` consults this directory only for the exact
package@version + license pairs listed above when normal license discovery in
the crate archive finds nothing; any other missing license fails the build with
the concrete package name.
