use std::{
  fs::File,
  io::Read,
  path::Path,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::bridge::{self, BridgeError};

/// Matches frontend/host attachment limits: up to 16 images, 16 MiB per image, 64 MiB per batch.
pub const MAX_PICKED_IMAGES: usize = 16;
pub const MAX_PICKED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PICKED_IMAGES_TOTAL_BYTES: usize = 64 * 1024 * 1024;

const IMAGE_FILE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopImagePickSource {
  Files,
  Clipboard,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedImageData {
  pub name: String,
  pub mime_type: String,
  pub data: String,
}

pub async fn pick_images(
  app: AppHandle,
  source: DesktopImagePickSource,
) -> Result<Vec<PickedImageData>, BridgeError> {
  match source {
    DesktopImagePickSource::Files => pick_images_from_files(app).await,
    DesktopImagePickSource::Clipboard => read_clipboard_image(app).await,
  }
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
  if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
    return Some("image/png");
  }
  if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
    return Some("image/jpeg");
  }
  if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    return Some("image/webp");
  }
  if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
    return Some("image/gif");
  }
  if bytes.len() >= 2 && &bytes[..2] == b"BM" {
    return Some("image/bmp");
  }
  None
}

fn read_picked_image_file(
  raw_path: &Path,
  remaining_total_bytes: usize,
) -> Result<(PickedImageData, usize), BridgeError> {
  let file_ref = bridge::validate_picked_regular_file(raw_path)?;
  if file_ref.size == 0 {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected image file is empty",
      "not-sent",
    ));
  }
  if file_ref.size > MAX_PICKED_IMAGE_BYTES as u64 {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected image exceeds 16 MiB limit",
      "not-sent",
    ));
  }
  if file_ref.size > remaining_total_bytes as u64 {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected images exceed 64 MiB total limit",
      "not-sent",
    ));
  }

  let file = File::open(raw_path).map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to open selected image file",
      "not-sent",
    )
  })?;
  let meta = file.metadata().map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to stat selected image file",
      "not-sent",
    )
  })?;
  if !meta.file_type().is_file() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected path must be a regular file",
      "not-sent",
    ));
  }
  let opened_len = meta.len();
  if opened_len == 0 {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected image file is empty",
      "not-sent",
    ));
  }
  if opened_len > MAX_PICKED_IMAGE_BYTES as u64 {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected image exceeds 16 MiB limit",
      "not-sent",
    ));
  }
  if opened_len > remaining_total_bytes as u64 {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected images exceed 64 MiB total limit",
      "not-sent",
    ));
  }

  // Bounded read (+1 sentinel byte) prevents unbounded memory growth if the file grows mid-read.
  let max_read = remaining_total_bytes.min(MAX_PICKED_IMAGE_BYTES);
  let mut bytes = Vec::with_capacity((opened_len as usize).min(max_read));
  let mut limited = file.take((max_read as u64) + 1);
  limited.read_to_end(&mut bytes).map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to read selected image file",
      "not-sent",
    )
  })?;
  if bytes.is_empty() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected image file is empty",
      "not-sent",
    ));
  }
  if bytes.len() > MAX_PICKED_IMAGE_BYTES {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected image exceeds 16 MiB limit",
      "not-sent",
    ));
  }
  if bytes.len() > remaining_total_bytes {
    return Err(BridgeError::new(
      "IMAGE_TOO_LARGE",
      "selected images exceed 64 MiB total limit",
      "not-sent",
    ));
  }

  let Some(mime_type) = detect_image_mime(&bytes) else {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected file is not a supported image",
      "not-sent",
    ));
  };

  let byte_len = bytes.len();
  let data = STANDARD.encode(&bytes);
  Ok((
    PickedImageData {
      name: file_ref.name,
      mime_type: mime_type.to_string(),
      data,
    },
    byte_len,
  ))
}

async fn pick_images_from_files(app: AppHandle) -> Result<Vec<PickedImageData>, BridgeError> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut dialog = app
      .dialog()
      .file()
      .add_filter("Images", IMAGE_FILE_EXTENSIONS);
    if let Some(window) = app.get_window("main") {
      dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_pick_files() else {
      return Ok(Vec::new());
    };
    if picked.is_empty() {
      return Ok(Vec::new());
    }
    if picked.len() > MAX_PICKED_IMAGES {
      return Err(BridgeError::new(
        "TOO_MANY_IMAGES",
        format!("at most {MAX_PICKED_IMAGES} images can be selected at once"),
        "not-sent",
      ));
    }

    let mut images = Vec::with_capacity(picked.len());
    let mut total_bytes: usize = 0;
    for file_path in picked {
      let raw_path = file_path.into_path().map_err(|_| {
        BridgeError::new(
          "INVALID_ARGUMENT",
          "selected item is not a local filesystem path",
          "not-sent",
        )
      })?;
      let remaining = MAX_PICKED_IMAGES_TOTAL_BYTES.saturating_sub(total_bytes);
      let (image, byte_len) = read_picked_image_file(&raw_path, remaining)?;
      total_bytes = total_bytes.saturating_add(byte_len);
      images.push(image);
    }
    Ok(images)
  })
  .await
  .map_err(|_| BridgeError::new("INTERNAL", "image dialog worker failed", "not-sent"))?
}

#[cfg(target_os = "linux")]
const CLIPBOARD_IMAGE_TARGETS: &[(&str, &str)] = &[
  ("image/png", "clipboard.png"),
  ("image/jpeg", "clipboard.jpg"),
  ("image/webp", "clipboard.webp"),
];

#[cfg(target_os = "linux")]
const CLIPBOARD_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(target_os = "linux")]
struct RawClipboardImage {
  name: &'static str,
  mime_type: &'static str,
  bytes: Vec<u8>,
}

#[cfg(target_os = "linux")]
fn request_clipboard_image_candidates(
  clipboard: gtk::Clipboard,
  candidates: Vec<(&'static str, &'static str)>,
  index: usize,
  tx: tokio::sync::oneshot::Sender<Result<Option<RawClipboardImage>, BridgeError>>,
) {
  let Some(&(mime, default_name)) = candidates.get(index) else {
    let _ = tx.send(Ok(None));
    return;
  };
  let target_atom = gtk::gdk::Atom::intern(mime);
  clipboard.request_contents(&target_atom, move |clipboard, selection_data| {
    let raw_len = selection_data.length();
    if raw_len <= 0 {
      request_clipboard_image_candidates(clipboard.clone(), candidates, index + 1, tx);
      return;
    }
    let byte_len = raw_len as usize;
    if byte_len > MAX_PICKED_IMAGE_BYTES {
      let _ = tx.send(Err(BridgeError::new(
        "IMAGE_TOO_LARGE",
        "clipboard image exceeds 16 MiB limit",
        "not-sent",
      )));
      return;
    }
    let bytes = selection_data.data();
    if bytes.is_empty() {
      request_clipboard_image_candidates(clipboard.clone(), candidates, index + 1, tx);
      return;
    }
    if bytes.len() > MAX_PICKED_IMAGE_BYTES {
      let _ = tx.send(Err(BridgeError::new(
        "IMAGE_TOO_LARGE",
        "clipboard image exceeds 16 MiB limit",
        "not-sent",
      )));
      return;
    }
    let Some(detected_mime) = detect_image_mime(&bytes) else {
      request_clipboard_image_candidates(clipboard.clone(), candidates, index + 1, tx);
      return;
    };
    let name = match detected_mime {
      "image/png" => "clipboard.png",
      "image/jpeg" => "clipboard.jpg",
      "image/webp" => "clipboard.webp",
      "image/gif" => "clipboard.gif",
      "image/bmp" => "clipboard.bmp",
      _ => default_name,
    };
    let _ = tx.send(Ok(Some(RawClipboardImage {
      name,
      mime_type: detected_mime,
      bytes,
    })));
  });
}

#[cfg(target_os = "linux")]
async fn read_clipboard_image(app: AppHandle) -> Result<Vec<PickedImageData>, BridgeError> {
  let (tx, rx) = tokio::sync::oneshot::channel::<Result<Option<RawClipboardImage>, BridgeError>>();
  app
    .run_on_main_thread(move || {
      if !gtk::is_initialized_main_thread() {
        let _ = tx.send(Err(BridgeError::new(
          "INTERNAL",
          "GTK main thread is not initialized",
          "not-sent",
        )));
        return;
      }
      let Some(display) = gtk::gdk::Display::default() else {
        let _ = tx.send(Err(BridgeError::new(
          "CLIPBOARD_UNAVAILABLE",
          "display is unavailable for clipboard read",
          "not-sent",
        )));
        return;
      };
      let clipboard = gtk::Clipboard::for_display(&display, &gtk::gdk::SELECTION_CLIPBOARD);
      let targets_atom = gtk::gdk::Atom::intern("TARGETS");
      clipboard.request_contents(&targets_atom, move |clipboard, selection_data| {
        let candidates: Vec<(&'static str, &'static str)> = match selection_data.targets() {
          Some(advertised) => {
            let names: Vec<String> = advertised
              .into_iter()
              .map(|atom| atom.name().to_string())
              .collect();
            CLIPBOARD_IMAGE_TARGETS
              .iter()
              .copied()
              .filter(|(mime, _)| names.iter().any(|name| name.eq_ignore_ascii_case(mime)))
              .collect()
          }
          // Fall back to probing image/png directly if TARGETS is unavailable.
          None => vec![("image/png", "clipboard.png")],
        };
        if candidates.is_empty() {
          let _ = tx.send(Ok(None));
          return;
        }
        request_clipboard_image_candidates(clipboard.clone(), candidates, 0, tx);
      });
    })
    .map_err(|_| {
      BridgeError::new(
        "INTERNAL",
        "failed to dispatch clipboard read to main thread",
        "not-sent",
      )
    })?;

  let raw = match tokio::time::timeout(CLIPBOARD_READ_TIMEOUT, rx).await {
    Ok(Ok(Ok(Some(raw)))) => raw,
    Ok(Ok(Ok(None))) => return Ok(Vec::new()),
    Ok(Ok(Err(err))) => return Err(err),
    Ok(Err(_)) => {
      return Err(BridgeError::new(
        "INTERNAL",
        "clipboard read did not complete",
        "not-sent",
      ));
    }
    Err(_) => {
      return Err(BridgeError::new(
        "TIMEOUT",
        "timed out reading image from clipboard",
        "not-sent",
      ));
    }
  };

  let encoded = tauri::async_runtime::spawn_blocking(move || {
    let data = STANDARD.encode(&raw.bytes);
    PickedImageData {
      name: raw.name.to_string(),
      mime_type: raw.mime_type.to_string(),
      data,
    }
  })
  .await
  .map_err(|_| BridgeError::new("INTERNAL", "clipboard image encoding failed", "not-sent"))?;

  Ok(vec![encoded])
}

#[cfg(not(target_os = "linux"))]
async fn read_clipboard_image(_app: AppHandle) -> Result<Vec<PickedImageData>, BridgeError> {
  Ok(Vec::new())
}
