# Cua driver vendored license text

The built-in Host Cua driver ships upstream release binaries
(`cua-driver-rs-v0.38.0`, tag commit
`85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`). The published `-binary`
archives (Windows `.zip`, Linux `.tar.gz`) do not include a license file, so
the MIT text is vendored here verbatim.

| File | Package | Version | License | Upstream source |
| --- | --- | --- | --- | --- |
| `LICENSE-MIT.txt` | cua-driver (cua-driver-rs) | 0.38.0 | MIT | https://raw.githubusercontent.com/trycua/cua/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/LICENSE.md |

`host-core/build-cua-driver.js` copies this text to `LICENSE` inside each
staged driver directory, and `host-core/build-desktop.js` appends it to the
desktop `THIRD_PARTY_NOTICES.txt`. The workspace declares `license = "MIT"`
(`libs/cua-driver/rust/Cargo.toml` at the same commit).
