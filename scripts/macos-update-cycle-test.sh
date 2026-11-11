#!/usr/bin/env bash
# scripts/macos-update-cycle-test.sh — run the desktop update cycle (stop the
# Host and unload its LaunchAgent → replace PiBot.app → re-enable and restart)
# against real launchd on this Mac, through the app's own cycle code.
#
#   scripts/macos-update-cycle-test.sh [path/to/PiBot.app]
#
# Uses a throwaway LaunchAgent label, a temporary Host home and copies of the
# given bundle (default: the local release build) carrying a debug launcher,
# so the product LaunchAgent and user data are never touched. Needs a
# logged-in GUI session (launchd domain gui/<uid>).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
app=${1:-$root/desktop/build/target/release/bundle/macos/PiBot.app}
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }
[ -x "$app/Contents/MacOS/pibot-host" ] || { echo "not a built PiBot.app: $app" >&2; exit 2; }
app=$(cd "$app" && pwd)
if ! launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
  echo "launchd domain gui/$(id -u) is missing; run from a logged-in GUI session" >&2
  exit 2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/pibot-update-cycle.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Only debug launchers honour E_LAUNCHER_LAUNCHD_LABEL. Build one in its own
# target dir: the Tauri build copies the bundled launcher over debug/pibot-host.
cargo build --locked --quiet --manifest-path "$root/desktop/host-launcher/Cargo.toml" --target-dir "$work/launcher-target"

export PIBOT_LAUNCHD_TEST_APP="$app"
export PIBOT_LAUNCHD_TEST_LAUNCHER="$work/launcher-target/debug/pibot-host"
export PIBOT_LAUNCHD_TEST_DIR="$work/fixture"
export E_LAUNCHER_HOST_HOME="$work/fixture/host-home"
export E_LAUNCHER_LAUNCHD_LABEL="io.github.firespoonyz.pibot.host-update-cycle-$$"
mkdir -p "$PIBOT_LAUNCHD_TEST_DIR"
cargo test --locked --manifest-path "$root/desktop/src-tauri/Cargo.toml" --lib -- \
  --ignored --exact host_service::tests::launchd::update_cycle_against_real_launchd --nocapture
