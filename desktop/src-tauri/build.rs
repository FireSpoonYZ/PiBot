const APP_COMMANDS: &[&str] = &[
  "desktop_request",
  "desktop_pet",
  "desktop_pet_voice",
  "desktop_open_center",
  "desktop_observe",
  "desktop_browser_guest",
  "desktop_browser_local_route",
  "desktop_unobserve",
  "desktop_pick_file",
  "desktop_pick_images",
  "desktop_host_status",
  "desktop_host_pair",
  "desktop_host_pair_code",
  "desktop_host_connect_local",
  "desktop_host_adopt",
  "desktop_host_control",
  "desktop_update_status",
  "desktop_update_check",
  "desktop_update_download",
  "desktop_update_install",
  "desktop_update_cancel",
  "desktop_clipboard_sync",
];

fn main() {
  println!("cargo:rerun-if-changed=../../assets/icon.png");
  println!("cargo:rerun-if-changed=../build/icons/icon.ico");
  println!("cargo:rerun-if-changed=../build/icons/icon.png");
  println!("cargo:rerun-if-changed=capabilities/main.json");
  println!("cargo:rerun-if-changed=capabilities/pet.json");
  println!("cargo:rerun-if-changed=permissions/clipboard.toml");
  let attributes = tauri_build::Attributes::new()
    .windows_attributes(
      tauri_build::WindowsAttributes::new().window_icon_path("../build/icons/icon.ico"),
    )
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
