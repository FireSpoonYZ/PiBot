//! Optional speech for the local desktop pet. Credentials stay in the native process.
use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::Mutex, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Webview};
use tokio::task::AbortHandle;

use crate::bridge::BridgeError;

#[derive(Default)]
pub struct PetVoiceState {
  jobs: Mutex<HashMap<(String, String), AbortHandle>>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
  base_url: String,
  model: String,
  #[serde(default)]
  voice: String,
  #[serde(default)]
  api_key: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
  stt: Endpoint,
  tts: Endpoint,
  tts_engine: String,
  language: String,
  speech_rate: f32,
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      stt: Endpoint { model: "whisper-1".into(), ..Endpoint::default() },
      tts: Endpoint { model: "gpt-4o-mini-tts".into(), voice: "alloy".into(), ..Endpoint::default() },
      tts_engine: "system".into(),
      language: String::new(),
      speech_rate: 1.0,
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInput {
  base_url: String,
  model: String,
  #[serde(default)]
  voice: String,
  api_key: Option<String>,
  #[serde(default)]
  clear_api_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
  stt: EndpointInput,
  tts: EndpointInput,
  tts_engine: String,
  language: String,
  speech_rate: f32,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum VoiceRequest {
  SettingsGet,
  SettingsSave { settings: SettingsInput },
  Transcribe { request_id: String, audio_base64: String },
  Speak { request_id: String, text: String },
  Cancel { request_id: String },
}

fn error(code: &str, message: impl Into<String>) -> BridgeError {
  BridgeError::new(code, message, "not-sent")
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, BridgeError> {
  app.path().app_config_dir()
    .map(|dir| dir.join("pet-voice.json"))
    .map_err(|_| error("VOICE_SETTINGS", "无法访问语音设置目录"))
}

fn load_settings(app: &AppHandle) -> Result<Settings, BridgeError> {
  match fs::read(settings_path(app)?) {
    Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error("VOICE_SETTINGS", "语音设置无法读取，请重新保存")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
    Err(_) => Err(error("VOICE_SETTINGS", "无法读取语音设置")),
  }
}

fn public_settings(settings: &Settings) -> Value {
  let endpoint = |e: &Endpoint| json!({
    "baseUrl": e.base_url, "model": e.model, "voice": e.voice, "hasApiKey": !e.api_key.is_empty()
  });
  json!({
    "stt": endpoint(&settings.stt), "tts": endpoint(&settings.tts),
    "ttsEngine": settings.tts_engine, "language": settings.language, "speechRate": settings.speech_rate
  })
}

fn normalize_endpoint(input: EndpointInput, old: &Endpoint) -> Result<Endpoint, BridgeError> {
  let base_url = input.base_url.trim().trim_end_matches('/').to_owned();
  if !base_url.is_empty() {
    let url = reqwest::Url::parse(&base_url).map_err(|_| error("INVALID_ARGUMENT", "语音接口地址无效"))?;
    let loopback = url.host_str().is_some_and(|host| {
      host == "localhost" || host == "[::1]" || host == "::1"
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
      || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
      || url.query().is_some() || url.fragment().is_some()
    {
      return Err(error("INVALID_ARGUMENT", "接口需为 HTTPS 地址，本机服务可使用 HTTP；地址中不能包含密钥或参数"));
    }
    if input.model.trim().is_empty() {
      return Err(error("INVALID_ARGUMENT", "请填写语音模型名称"));
    }
  }
  let api_key = if input.clear_api_key {
    String::new()
  } else {
    input.api_key.filter(|key| !key.trim().is_empty())
      .map(|key| key.trim().to_owned()).unwrap_or_else(|| old.api_key.clone())
  };
  Ok(Endpoint { base_url, model: input.model.trim().into(), voice: input.voice.trim().into(), api_key })
}

fn save_settings(app: &AppHandle, input: SettingsInput) -> Result<Value, BridgeError> {
  if !matches!(input.tts_engine.as_str(), "system" | "remote") {
    return Err(error("INVALID_ARGUMENT", "朗读引擎无效"));
  }
  if !input.speech_rate.is_finite() || !(0.5..=2.0).contains(&input.speech_rate) {
    return Err(error("INVALID_ARGUMENT", "朗读速度应在 0.5 到 2 倍之间"));
  }
  let old = load_settings(app)?;
  let settings = Settings {
    stt: normalize_endpoint(input.stt, &old.stt)?,
    tts: normalize_endpoint(input.tts, &old.tts)?,
    tts_engine: input.tts_engine,
    language: input.language.trim().into(),
    speech_rate: input.speech_rate,
  };
  let path = settings_path(app)?;
  let directory = path.parent().ok_or_else(|| error("VOICE_SETTINGS", "语音设置目录无效"))?;
  fs::create_dir_all(directory).map_err(|_| error("VOICE_SETTINGS", "无法创建语音设置目录"))?;
  let mut file = tempfile::NamedTempFile::new_in(directory)
    .map_err(|_| error("VOICE_SETTINGS", "无法保存语音设置"))?;
  serde_json::to_writer(&mut file, &settings).map_err(|_| error("VOICE_SETTINGS", "无法保存语音设置"))?;
  file.flush().map_err(|_| error("VOICE_SETTINGS", "无法保存语音设置"))?;
  file.persist(path).map_err(|_| error("VOICE_SETTINGS", "无法保存语音设置"))?;
  Ok(public_settings(&settings))
}

fn client() -> Result<reqwest::Client, BridgeError> {
  // reqwest uses rustls-no-provider; retain an existing provider or install ring.
  let _ = rustls::crypto::ring::default_provider().install_default();
  reqwest::Client::builder().timeout(Duration::from_secs(120))
    .redirect(reqwest::redirect::Policy::none())
    .build().map_err(|_| error("VOICE_SERVICE", "无法启动语音服务请求"))
}

fn request(client: &reqwest::Client, endpoint: &Endpoint, path: &str) -> Result<reqwest::RequestBuilder, BridgeError> {
  if endpoint.base_url.is_empty() || endpoint.model.is_empty() {
    return Err(error("VOICE_NOT_CONFIGURED", "请先在语音设置中填写接口地址与模型"));
  }
  let request = client.post(format!("{}{}", endpoint.base_url, path));
  Ok(if endpoint.api_key.is_empty() { request } else { request.bearer_auth(&endpoint.api_key) })
}

async fn checked_response(request: reqwest::RequestBuilder) -> Result<reqwest::Response, BridgeError> {
  let response = request.send().await.map_err(|e| {
    error("VOICE_SERVICE", if e.is_timeout() { "语音服务请求超时" } else { "无法连接语音服务，请检查地址和网络" })
  })?;
  if !response.status().is_success() {
    return Err(error("VOICE_SERVICE", format!("语音服务返回 HTTP {}，请检查模型与凭据", response.status().as_u16())));
  }
  Ok(response)
}

async fn transcribe(settings: Settings, audio_base64: String) -> Result<Value, BridgeError> {
  let bytes = STANDARD.decode(audio_base64).map_err(|_| error("INVALID_ARGUMENT", "录音格式无效"))?;
  if bytes.len() < 44 || bytes.len() > 8 * 1024 * 1024 || !bytes.starts_with(b"RIFF") {
    return Err(error("INVALID_ARGUMENT", "录音为空、过长或不是 WAV 格式"));
  }
  let part = reqwest::multipart::Part::bytes(bytes).file_name("recording.wav")
    .mime_str("audio/wav").map_err(|_| error("INVALID_ARGUMENT", "录音格式无效"))?;
  let mut form = reqwest::multipart::Form::new().text("model", settings.stt.model.clone())
    .text("response_format", "json").part("file", part);
  if !settings.language.is_empty() {
    form = form.text("language", settings.language.split('-').next().unwrap_or("").to_owned());
  }
  let client = client()?;
  let response = checked_response(request(&client, &settings.stt, "/audio/transcriptions")?.multipart(form)).await?;
  let body: Value = response.json().await.map_err(|_| error("VOICE_SERVICE", "语音服务未返回有效转写结果"))?;
  let text = body.get("text").and_then(Value::as_str)
    .ok_or_else(|| error("VOICE_SERVICE", "语音服务未返回转写文本"))?;
  Ok(json!({ "text": text }))
}

fn audio_mime_type(response: &reqwest::Response) -> String {
  response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(';').next())
    .map(str::trim)
    .filter(|mime| mime.starts_with("audio/") && mime.len() <= 64)
    .unwrap_or("audio/mpeg")
    .to_owned()
}

async fn speak(settings: Settings, text: String) -> Result<Value, BridgeError> {
  if text.trim().is_empty() || text.len() > 64 * 1024 {
    return Err(error("INVALID_ARGUMENT", "朗读文本为空或过长"));
  }
  let client = client()?;
  let mut body = json!({
    "model": settings.tts.model, "input": text, "response_format": "mp3", "speed": settings.speech_rate
  });
  if !settings.tts.voice.is_empty() {
    body["voice"] = Value::String(settings.tts.voice.clone());
  }
  let response = checked_response(request(&client, &settings.tts, "/audio/speech")?.json(&body)).await?;
  let mime_type = audio_mime_type(&response);
  let bytes = response.bytes().await.map_err(|_| error("VOICE_SERVICE", "无法读取语音音频"))?;
  if bytes.is_empty() {
    return Err(error("VOICE_SERVICE", "语音服务返回了空音频"));
  }
  Ok(json!({ "audioBase64": STANDARD.encode(bytes), "mimeType": mime_type }))
}

/// A closed pet must not leave a microphone request or remote speech job behind.
pub fn cancel_window_jobs(app: &AppHandle, label: &str) {
  if let Some(state) = app.try_state::<PetVoiceState>() {
    let mut jobs = state.jobs.lock().unwrap_or_else(|e| e.into_inner());
    jobs.retain(|(window, _), handle| {
      if window == label { handle.abort(); false } else { true }
    });
  }
}

#[tauri::command]
pub async fn desktop_pet_voice(
  app: AppHandle,
  webview: Webview,
  state: State<'_, PetVoiceState>,
  request: VoiceRequest,
) -> Result<Value, BridgeError> {
  let label = webview.label();
  if !matches!(label, "main" | "pet") || webview.window().label() != label {
    return Err(error("UNAUTHORIZED", "语音仅供本地桌面界面使用"));
  }
  // Navigation is restricted by the application's local-view navigation guard.
  match request {
    VoiceRequest::SettingsGet => return Ok(public_settings(&load_settings(&app)?)),
    VoiceRequest::SettingsSave { settings } => return save_settings(&app, settings),
    VoiceRequest::Cancel { request_id } => {
      if let Some(handle) = state.jobs.lock().unwrap_or_else(|e| e.into_inner())
        .remove(&(label.to_owned(), request_id))
      {
        handle.abort();
      }
      return Ok(json!({}));
    }
    _ => {}
  }
  let settings = load_settings(&app)?;
  let (request_id, task) = match request {
    VoiceRequest::Transcribe { request_id, audio_base64 } => {
      (request_id, tokio::spawn(transcribe(settings, audio_base64)))
    }
    VoiceRequest::Speak { request_id, text } => (request_id, tokio::spawn(speak(settings, text))),
    _ => unreachable!(),
  };
  let key = (label.to_owned(), request_id);
  state.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), task.abort_handle());
  let result = task.await;
  state.jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
  match result {
    Ok(result) => result,
    Err(e) if e.is_cancelled() => Err(error("VOICE_CANCELLED", "语音已停止")),
    Err(_) => Err(error("VOICE_SERVICE", "语音处理失败")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{io::{Read, Write}, net::TcpListener, thread};

  fn service(content_type: &'static str, body: &'static str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
      let (mut socket, _) = listener.accept().unwrap();
      socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
      let mut data = Vec::new();
      let mut chunk = [0u8; 4096];
      loop {
        let count = socket.read(&mut chunk).unwrap();
        assert!(count > 0, "request ended before its body");
        data.extend_from_slice(&chunk[..count]);
        if let Some(end) = data.windows(4).position(|part| part == b"\r\n\r\n") {
          let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
          let length = headers.lines().find_map(|line| line.strip_prefix("content-length:"))
            .map(|value| value.trim().parse::<usize>().unwrap()).unwrap();
          if data.len() >= end + 4 + length { break; }
        }
      }
      write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
      String::from_utf8_lossy(&data).into_owned()
    });
    (base, handle)
  }

  #[tokio::test]
  async fn transcription_sends_wav_to_compatible_local_service() {
    let (base, request) = service("application/json", r#"{"text":"测试转写"}"#);
    let mut settings = Settings::default();
    settings.stt.base_url = base;
    settings.stt.api_key = "test-key".into();
    settings.language = "zh-CN".into();
    let mut wav = vec![0; 46];
    wav[..4].copy_from_slice(b"RIFF");
    wav[8..12].copy_from_slice(b"WAVE");
    let result = transcribe(settings, STANDARD.encode(wav)).await.unwrap();
    assert_eq!(result["text"], "测试转写");
    let request = request.join().unwrap();
    assert!(request.starts_with("POST /v1/audio/transcriptions "));
    assert!(request.to_lowercase().contains("authorization: bearer test-key"));
    assert!(request.contains("filename=\"recording.wav\""));
    assert!(request.contains("audio/wav"));
    assert!(request.contains("whisper-1"));
    assert!(request.contains("\r\n\r\nzh\r\n"));
  }

  #[tokio::test]
  async fn speech_uses_configured_voice_rate_and_returns_audio() {
    let (base, request) = service("audio/mpeg", "ID3-test-audio");
    let mut settings = Settings::default();
    settings.tts.base_url = base;
    settings.speech_rate = 1.25;
    let result = speak(settings, "测试朗读".into()).await.unwrap();
    assert_eq!(result["mimeType"], "audio/mpeg");
    assert_eq!(STANDARD.decode(result["audioBase64"].as_str().unwrap()).unwrap(), b"ID3-test-audio");
    let request = request.join().unwrap();
    assert!(request.starts_with("POST /v1/audio/speech "));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["input"], "测试朗读");
    assert_eq!(body["voice"], "alloy");
    assert_eq!(body["speed"], 1.25);
    assert_eq!(body["response_format"], "mp3");
  }

  #[tokio::test]
  async fn speech_forwards_valid_audio_mime_and_falls_back_for_non_audio() {
    let (wav_base, wav_req) = service("audio/wav; charset=binary", "RIFF-wav");
    let mut settings = Settings::default();
    settings.tts.base_url = wav_base;
    let wav_result = speak(settings, "测试 WAV".into()).await.unwrap();
    assert_eq!(wav_result["mimeType"], "audio/wav");
    let _ = wav_req.join().unwrap();

    let (bin_base, bin_req) = service("application/octet-stream", "ID3-fallback");
    let mut settings = Settings::default();
    settings.tts.base_url = bin_base;
    let bin_result = speak(settings, "测试回退".into()).await.unwrap();
    assert_eq!(bin_result["mimeType"], "audio/mpeg");
    let _ = bin_req.join().unwrap();
  }
}
