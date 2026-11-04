const APP_COMMANDS: &[&str] = &[
  "mobile_host_request",
  "mobile_host_listen",
  "mobile_host_ack",
  "mobile_host_unlisten",
];

fn main() {
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
