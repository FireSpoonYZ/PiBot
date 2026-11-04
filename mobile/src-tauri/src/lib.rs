// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! M18：Tauri 辅助 UI 进程（`:tauri_ui`）的 Rust 侧。
//!
//! 这里只做 IPC 转发。Host/Node/模型/FGS 仍在默认进程，本进程不运行 Host 循环，
//! 所以第三方 Android SDK 在 UI 进程退出时 `std::process::exit` 不会带走 Host。
//!
//! Kotlin 侧所有命令都用 `Invoke.resolve(NativeReply)` 返回：`{ok:true,result}` 或
//! `{ok:false,error:{code,message,outcome}}`。Rust 只解包结构，不重写/猜测 outcome。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::mobile::PluginInvokeError;
use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Manager, State, Webview, Wry};

/// Rust 插件名，同时是 Kotlin `PluginManager` 的 key（`runCommand` 的 pluginId）。
const PLUGIN_NAME: &str = "android-host";
const PLUGIN_PACKAGE: &str = "com.example.launcherprobe";
const PLUGIN_CLASS: &str = "BotHostTauriPlugin";
const MAIN_WEBVIEW_LABEL: &str = "main";
const MAX_ERROR_MESSAGE_CHARS: usize = 512;
/// 普通命令提前准入上限，超限立即拒绝，不排队。
const MAX_ORDINARY_IN_FLIGHT: usize = 8;
/// 客户端观察清理（clientUnobserve）独立额度：不占普通 8 槽，也不会无界并发。
const MAX_CLIENT_CLEANUP_IN_FLIGHT: usize = 2;
/// 单个 request 序列化负载上限（40MiB），在进入 SDK 队列前拦截。
const MAX_REQUEST_BYTES: usize = 40 * 1024 * 1024;

/// 唯一允许穿过 Rust→Kotlin 边界的方法集合：Kotlin 侧 UI-local 动作 + 固定 bridge op。
/// 其他 method 一律在 Rust 拒绝，不做任何泛化转发。
const ALLOWED_METHODS: &[&str] = &[
  // Kotlin 侧 UI-local 动作（不进 bridge 服务）
  "start",
  "stop",
  "openSystemSettings",
  "openCenter",
  "reconnect",
  "clientLaunchTarget",
  "hide",
  // 系统选图/拍照：Kotlin 侧 UI-local 原生能力（返回限尺寸 base64 图片，不进 bridge 服务）
  "pickImages",
  // Bot 屏幕：Kotlin 侧 UI-local 原生覆盖层（只观看/接管已有屏幕，不进 bridge 服务）
  "screenOpen",
  "screenLayout",
  "screenStatus",
  "screenTakeover",
  "screenClose",
  // 私有 bridge 服务的固定 op
  "snapshot",
  "status",
  "centerSettings",
  "saveCenterSettings",
  "settingsGet",
  "settingsSet",
  "saveCredentials",
  "call",
  "observe",
  "cancelObservation",
  "voiceSettings",
  "saveVoiceSettings",
  "startVoice",
  "finishVoice",
  "cancelVoice",
  "uiSettings",
  "pause",
  // M20 客户端（远端 Host）固定入口；内层 broker 操作由 Kotlin/Node 再校验 16 项白名单。
  // 客户端进程由应用级 broker 持有；UI 会话只释放自己的观察。
  "clientRequest",
  "clientObserve",
  "clientUnobserve",
  "clientChatVisibility",
];

/// 不占普通准入槽的本地 UI 动作：普通槽满时仍可执行，不产生 bridge 请求堆积。
const CLEANUP_METHODS: &[&str] = &[
  "hide",
  "reconnect",
  // 屏幕布局/状态/关闭是高频本地 UI 动作，不占普通准入槽。
  "screenLayout",
  "screenStatus",
  "screenClose",
];

/// 客户端观察清理：不占普通槽，改用独立小额度（与 Kotlin 侧同名额度一致），超限立即拒绝不排队。
const CLIENT_CLEANUP_METHODS: &[&str] = &["clientUnobserve"];

/// 归一化后的错误形状，前端按固定三态处理，不重试。
#[derive(Debug, Clone, Serialize)]
pub struct MobileHostError {
  pub code: String,
  pub message: String,
  pub outcome: String,
}

impl MobileHostError {
  fn new(code: &str, message: impl Into<String>, outcome: &str) -> Self {
    let code = code.trim();
    Self {
      code: if code.is_empty() {
        "INTERNAL".to_string()
      } else {
        code.to_string()
      },
      message: bound_message(message.into()),
      outcome: normalize_outcome(outcome).to_string(),
    }
  }

  /// 结构不合法（缺字段/无法解析）：不能证明未发送，保守按 `unconfirmed`。
  fn structural() -> Self {
    Self::new("INTERNAL", "原生 Host 响应结构无效", "unconfirmed")
  }

  /// 框架/JNI/传输层失败：同样不推断 not-sent。
  fn from_transport(error: PluginInvokeError) -> Self {
    match error {
      PluginInvokeError::InvokeRejected(rejection) => {
        let code = rejection.code.unwrap_or_default();
        Self::new(code.trim(), rejection.message.unwrap_or_default(), "unconfirmed")
      }
      PluginInvokeError::CannotDeserializeResponse(_) => Self::structural(),
      _ => Self::new("UNAVAILABLE", "原生 Host 通道不可用", "unconfirmed"),
    }
  }

  /// Kotlin 私有错误结构：code/message/outcome 原样保留（含 `EVENT_STREAM_CLOSED`），
  /// 仅缺失或非法 outcome 收敛为 `unconfirmed`，绝不改写成 Host 业务错误。
  fn from_native(error: Option<NativeFailure>) -> Self {
    match error {
      Some(failure) => Self::new(
        failure.code.unwrap_or_default().trim(),
        failure.message.unwrap_or_default(),
        failure.outcome.unwrap_or_default().as_str(),
      ),
      None => Self::structural(),
    }
  }
}

fn normalize_outcome(outcome: &str) -> &'static str {
  match outcome {
    "not-sent" => "not-sent",
    "responded" => "responded",
    _ => "unconfirmed",
  }
}

fn bound_message(message: String) -> String {
  let trimmed = message.trim();
  if trimmed.is_empty() {
    return "Host 操作失败".to_string();
  }
  trimmed.chars().take(MAX_ERROR_MESSAGE_CHARS).collect()
}

#[derive(Debug, Deserialize)]
struct NativeReply {
  ok: bool,
  #[serde(default)]
  result: Value,
  #[serde(default)]
  error: Option<NativeFailure>,
}

#[derive(Debug, Deserialize)]
struct NativeFailure {
  #[serde(default)]
  code: Option<String>,
  #[serde(default)]
  message: Option<String>,
  #[serde(default)]
  outcome: Option<String>,
}

/// 解包 Kotlin `NativeReply`，返回原有公开结果或原有错误三态。
fn decode_reply<T: DeserializeOwned>(reply: Value) -> Result<T, MobileHostError> {
  let native: NativeReply = serde_json::from_value(reply).map_err(|_| MobileHostError::structural())?;
  if native.ok {
    serde_json::from_value(native.result).map_err(|_| MobileHostError::structural())
  } else {
    Err(MobileHostError::from_native(native.error))
  }
}

async fn call_native(
  plugin: &PluginHandle<Wry>,
  command: &str,
  payload: Value,
) -> Result<Value, MobileHostError> {
  plugin
    .run_mobile_plugin_async::<Value>(command, payload)
    .await
    .map_err(MobileHostError::from_transport)
}

/// 普通命令准入（上限 8）与客户端清理准入（上限 2）：try-acquire 不排队；guard 随命令完成/取消释放。
#[derive(Default)]
struct CommandSlots {
  in_flight: AtomicUsize,
  client_cleanup_in_flight: AtomicUsize,
}

/// 持住一个已占用的额度，析构时归还到对应计数器。
struct CommandSlot<'a>(&'a AtomicUsize);

impl CommandSlots {
  fn try_acquire(&self) -> Option<CommandSlot<'_>> {
    acquire_slot(&self.in_flight, MAX_ORDINARY_IN_FLIGHT)
  }

  fn try_acquire_client_cleanup(&self) -> Option<CommandSlot<'_>> {
    acquire_slot(&self.client_cleanup_in_flight, MAX_CLIENT_CLEANUP_IN_FLIGHT)
  }
}

fn acquire_slot(counter: &AtomicUsize, limit: usize) -> Option<CommandSlot<'_>> {
  let mut current = counter.load(Ordering::Acquire);
  loop {
    if current >= limit {
      return None;
    }
    match counter.compare_exchange_weak(
      current,
      current + 1,
      Ordering::AcqRel,
      Ordering::Acquire,
    ) {
      Ok(_) => return Some(CommandSlot(counter)),
      Err(actual) => current = actual,
    }
  }
}

impl Drop for CommandSlot<'_> {
  fn drop(&mut self) {
    self.0.fetch_sub(1, Ordering::AcqRel);
  }
}

/// 当前前端监听通道；generation 用于防止旧 listen/unlisten 清理新流。
struct ListenerSlot {
  generation: u64,
  channel: Channel<Value>,
  failed: AtomicBool,
}

/// 每进程唯一的原生事件代理通道 + 当前前端监听槽。
#[derive(Default)]
struct EventHub {
  plugin: OnceLock<PluginHandle<Wry>>,
  current: Mutex<Option<Arc<ListenerSlot>>>,
  generations: AtomicU64,
  slots: CommandSlots,
}

impl EventHub {
  fn next_generation(&self) -> u64 {
    self.generations.fetch_add(1, Ordering::AcqRel) + 1
  }

  fn install(&self, listener: Arc<ListenerSlot>) {
    *self.current.lock().unwrap() = Some(listener);
  }

  fn clear_generation(&self, generation: u64) {
    let mut guard = self.current.lock().unwrap();
    if guard.as_ref().map(|slot| slot.generation) == Some(generation) {
      *guard = None;
    }
  }

  fn current_generation(&self) -> Option<u64> {
    self.current.lock().unwrap().as_ref().map(|slot| slot.generation)
  }

  /// 原生事件代理：原样转发 envelope，发送失败时异步通知 Kotlin 只失败当前在途 id。
  fn forward(&self, body: InvokeResponseBody) -> tauri::Result<()> {
    let envelope = match body {
      InvokeResponseBody::Json(json_text) => serde_json::from_str::<Value>(&json_text).ok(),
      InvokeResponseBody::Raw(_) => None,
    };
    let Some(envelope) = envelope else {
      return Ok(());
    };
    let slot = self.current.lock().unwrap().clone();
    let Some(slot) = slot else {
      return Ok(());
    };
    if slot.failed.load(Ordering::Acquire) {
      return Ok(());
    }
    if slot.channel.send(envelope.clone()).is_ok() {
      return Ok(());
    }
    slot.failed.store(true, Ordering::Release);
    let delivery_id = envelope
      .get("deliveryId")
      .and_then(Value::as_str)
      .filter(|id| !id.is_empty());
    if let Some(delivery_id) = delivery_id {
      self.notify_event_stream_closed(delivery_id.to_string());
    }
    Ok(())
  }

  fn notify_event_stream_closed(&self, delivery_id: String) {
    let Some(plugin) = self.plugin.get().cloned() else {
      return;
    };
    // 内部 helper，不属于公开四命令，也不接收任意 JS 输入；失败不重试。
    tauri::async_runtime::spawn(async move {
      let _ = plugin
        .run_mobile_plugin_async::<Value>("eventsFailed", json!({ "deliveryId": delivery_id }))
        .await;
    });
  }
}

struct HostBridge {
  plugin: PluginHandle<Wry>,
  hub: Arc<EventHub>,
  /// 交给 Kotlin 的唯一原生代理通道；前端 Channel 逐个 listen 换入槽位。
  proxy: Channel<Value>,
}

/// Android 上资产走 `https://tauri.localhost`；不放宽到任意来源。
fn is_allowed_tauri_origin(url: &tauri::Url) -> bool {
  url.scheme() == "https" && url.host_str() == Some("tauri.localhost")
}

/// 命令信任边界：只接受主 webview 且来源必须是 `https://tauri.localhost`。
fn ensure_main_origin(webview: &Webview) -> Result<(), MobileHostError> {
  if webview.label() != MAIN_WEBVIEW_LABEL {
    return Err(MobileHostError::new(
      "UNAUTHORIZED",
      "仅允许主界面调用 Host 桥",
      "not-sent",
    ));
  }
  match webview.url() {
    Ok(url) if is_allowed_tauri_origin(&url) => Ok(()),
    _ => Err(MobileHostError::new(
      "UNAUTHORIZED",
      "仅允许主界面来源调用 Host 桥",
      "not-sent",
    )),
  }
}

fn busy() -> MobileHostError {
  MobileHostError::new("RPC_BUSY", "并行 Host 请求已达上限", "not-sent")
}

#[tauri::command]
async fn mobile_host_request(
  webview: Webview,
  state: State<'_, HostBridge>,
  method: String,
  params: Value,
) -> Result<Value, MobileHostError> {
  ensure_main_origin(&webview)?;
  if !ALLOWED_METHODS.contains(&method.as_str()) {
    return Err(MobileHostError::new(
      "INVALID_ARGUMENT",
      "不支持的 Host 方法",
      "not-sent",
    ));
  }
  let params = match params {
    Value::Null => json!({}),
    Value::Object(map) => Value::Object(map),
    _ => {
      return Err(MobileHostError::new(
        "INVALID_ARGUMENT",
        "params 必须是对象",
        "not-sent",
      ))
    }
  };
  let is_client_cleanup = CLIENT_CLEANUP_METHODS.contains(&method.as_str());
  let is_cleanup = is_client_cleanup || CLEANUP_METHODS.contains(&method.as_str());
  let payload = json!({ "method": method, "params": params });
  let encoded_len = serde_json::to_string(&payload)
    .map_err(|_| MobileHostError::structural())?
    .len();
  if encoded_len > MAX_REQUEST_BYTES {
    return Err(MobileHostError::new(
      "REQUEST_TOO_LARGE",
      "Host 请求超过 40MiB",
      "not-sent",
    ));
  }

  let hub = state.hub.clone();
  let plugin = state.plugin.clone();
  let _slot = if is_client_cleanup {
    Some(hub.slots.try_acquire_client_cleanup().ok_or_else(busy)?)
  } else if is_cleanup {
    None
  } else {
    Some(hub.slots.try_acquire().ok_or_else(busy)?)
  };

  let reply = call_native(&plugin, "request", payload).await?;
  decode_reply::<Value>(reply)
}

#[tauri::command]
async fn mobile_host_listen(
  webview: Webview,
  state: State<'_, HostBridge>,
  on_event: Channel<Value>,
) -> Result<Value, MobileHostError> {
  ensure_main_origin(&webview)?;
  let hub = state.hub.clone();
  let plugin = state.plugin.clone();
  let proxy = state.proxy.clone();

  let _slot = hub.slots.try_acquire().ok_or_else(busy)?;

  // 先挂槽再调用原生：listen 结果返回前的帧也能到前端（前端按 streamId 前缀缓冲）。
  let generation = hub.next_generation();
  let listener = Arc::new(ListenerSlot {
    generation,
    channel: on_event,
    failed: AtomicBool::new(false),
  });
  hub.install(listener);

  let reply = call_native(&plugin, "listen", json!({ "onEvent": proxy })).await;
  let result = reply.and_then(decode_reply::<Value>);
  match result {
    Ok(value) => {
      let stream_id = value
        .get("streamId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
      if stream_id.is_empty() {
        hub.clear_generation(generation);
        return Err(MobileHostError::structural());
      }
      Ok(value)
    }
    Err(error) => {
      hub.clear_generation(generation);
      Err(error)
    }
  }
}

#[derive(Debug, Deserialize, Serialize)]
struct AckResult {
  acknowledged: bool,
}

#[tauri::command]
async fn mobile_host_ack(
  webview: Webview,
  state: State<'_, HostBridge>,
  delivery_id: String,
) -> Result<AckResult, MobileHostError> {
  ensure_main_origin(&webview)?;
  if delivery_id.trim().is_empty() {
    return Err(MobileHostError::new(
      "INVALID_ARGUMENT",
      "deliveryId 不能为空",
      "not-sent",
    ));
  }
  let plugin = state.plugin.clone();
  let reply = call_native(&plugin, "ack", json!({ "deliveryId": delivery_id })).await?;
  decode_reply::<AckResult>(reply)
}

#[tauri::command]
async fn mobile_host_unlisten(
  webview: Webview,
  state: State<'_, HostBridge>,
) -> Result<Value, MobileHostError> {
  ensure_main_origin(&webview)?;
  let hub = state.hub.clone();
  let plugin = state.plugin.clone();
  let generation = hub.current_generation();

  let reply = call_native(&plugin, "unlisten", json!({})).await;
  // 只清调用时的那一代，旧 unlisten 完成不得移除新流。
  if let Some(generation) = generation {
    hub.clear_generation(generation);
  }
  decode_reply::<Value>(reply?)
}

fn navigation_guard() -> TauriPlugin<Wry> {
  PluginBuilder::<Wry, ()>::new("navigation-guard")
    .on_navigation(|webview, url| {
      webview.label() == MAIN_WEBVIEW_LABEL && is_allowed_tauri_origin(url)
    })
    .build()
}

/// 注册本进程内唯一的 Kotlin 插件；注册失败直接让 App 启动失败，不留占位实现。
fn host_plugin() -> TauriPlugin<Wry> {
  let builder = PluginBuilder::<Wry, ()>::new(PLUGIN_NAME)
    .setup(|app, api| {
      let hub = Arc::new(EventHub::default());
      let proxy = {
        let hub = hub.clone();
        Channel::<Value>::new(move |body| hub.forward(body))
      };
      let plugin = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
      let _ = hub.plugin.set(plugin.clone());
      let _ = app.manage(HostBridge {
        plugin,
        hub,
        proxy,
      });
      Ok(())
    });
  // Activity 最终销毁后由 Java 终止 UI 进程，避免 tao 的 C 全局析构与绘图线程冲突。
  #[cfg(target_os = "android")]
  let builder = builder.on_event(|_app, event| {
    if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
      api.prevent_exit();
    }
  });
  builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(navigation_guard())
    .plugin(host_plugin())
    .invoke_handler(tauri::generate_handler![
      mobile_host_request,
      mobile_host_listen,
      mobile_host_ack,
      mobile_host_unlisten,
    ])
    .run(tauri::generate_context!())
    .expect("failed to run the e-launcher mobile UI");
}
