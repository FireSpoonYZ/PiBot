const APP_COMMANDS: &[&str] = &[
  "desktop_request",
  "desktop_open_center",
  "desktop_observe",
  "desktop_unobserve",
  "desktop_pick_file",
  "desktop_host_status",
  "desktop_host_pair",
  "desktop_host_adopt",
  "desktop_host_control",
  "desktop_update_status",
  "desktop_update_check",
  "desktop_update_download",
  "desktop_update_install",
  "desktop_update_cancel",
];

fn main() {
  println!("cargo:rerun-if-env-changed=E_LAUNCHER_UPDATER_PUBLIC_KEY");
  println!("cargo:rerun-if-changed=../../assets/icon.png");
  println!("cargo:rerun-if-changed=../build/icons/icon.ico");
  let attributes = tauri_build::Attributes::new()
    .windows_attributes(
      tauri_build::WindowsAttributes::new().window_icon_path("../build/icons/icon.ico"),
    )
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
