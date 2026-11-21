//! Browser guests never receive application capabilities. Only the trusted main
//! document can use this bounded interface; no arbitrary JS/CDP is accepted.
use crate::BridgeError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview, WebviewBuilder, WebviewUrl};

const LEASE: Duration = Duration::from_secs(6);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct BrowserGuests(Mutex<HashMap<String, Guest>>, AtomicBool);
struct Guest {
    holder: String,
    title: String,
    visible_until: Option<Instant>,
    bounds: Bounds,
    document_generation: u64,
    loading: bool,
    mutations: Arc<tokio::sync::Mutex<()>>,
    capture: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    operation: String,
    guest_id: Option<String>,
    host_id: Option<String>,
    bot_id: Option<String>,
    holder: String,
    url: Option<String>,
    proxy_url: Option<String>,
    bounds: Option<Bounds>,
    action: Option<String>,
    #[serde(rename = "ref")]
    element_ref: Option<u32>,
    text: Option<String>,
    event: Option<Value>,
    wait: Option<WaitCondition>,
    expected_url: Option<String>,
    document_generation: Option<u64>,
    ttl_ms: Option<u64>,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct WaitCondition {
    selector: Option<String>,
    state: Option<String>,
    text: Option<String>,
    url: Option<String>,
    load: Option<String>,
}
impl Bounds {
    const INITIAL: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 1024.0,
        height: 768.0,
    };
    const PARKED: f64 = -20000.0;

    fn apply(self, view: &Webview, visible: bool) -> tauri::Result<()> {
        let (x, y) = if visible {
            (self.x, self.y)
        } else {
            (Self::PARKED, Self::PARKED)
        };
        view.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(x, y).into(),
            size: tauri::LogicalSize::new(self.width, self.height).into(),
        })
    }
}
fn error(message: impl Into<String>) -> BridgeError {
    BridgeError::new("BROWSER_GUEST", message, "not-sent")
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:@".contains(&c))
}
pub fn allowed_url(url: &tauri::Url) -> bool {
    (url.as_str() == "about:blank")
        || (matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url
                .host_str()
                .is_some_and(|host| host != "tauri.localhost" && host != "asset.localhost")
            && !(matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                && url.port() == Some(1420)))
}
fn parse_url(value: &str) -> Result<tauri::Url, BridgeError> {
    let url = tauri::Url::parse(value).map_err(|_| error("Invalid URL"))?;
    if !allowed_url(&url) || value.len() > 8192 {
        return Err(error("Unsupported browser URL"));
    }
    Ok(url)
}
pub fn permits(app: &AppHandle, label: &str, url: &tauri::Url) -> bool {
    allowed_url(url)
        && app
            .state::<BrowserGuests>()
            .0
            .lock()
            .map(|entries| entries.contains_key(label))
            .unwrap_or(false)
}
pub fn hide_all(app: &AppHandle) {
    if let Ok(mut entries) = app.state::<BrowserGuests>().0.lock() {
        for (id, guest) in entries.iter_mut() {
            if guest.visible_until.take().is_some() {
                if let Some(view) = app.get_webview(id) {
                    let _ = guest.bounds.apply(&view, false);
                }
            }
        }
    }
}
pub fn begin_window_close(app: &AppHandle) -> Option<Vec<String>> {
    let guests = app.state::<BrowserGuests>();
    if guests.1.swap(true, Ordering::AcqRel) {
        return None;
    }
    let ids = guests.0.lock()
        .map(|mut entries| entries.drain().map(|(id, _)| id).collect())
        .unwrap_or_default();
    Some(ids)
}

pub fn close_drained_guests(app: &AppHandle, ids: Vec<String>) {
    for id in ids {
        if let Some(view) = app.get_webview(&id) {
            let _ = view.close();
        }
    }
}

pub fn start_watchdog(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        if let Ok(mut entries) = app.state::<BrowserGuests>().0.lock() {
            for (id, guest) in entries.iter_mut() {
                if guest
                    .visible_until
                    .is_some_and(|until| until <= Instant::now())
                {
                    guest.visible_until = None;
                    if let Some(view) = app.get_webview(id) {
                        let _ = guest.bounds.apply(&view, false);
                    }
                    if app
                        .get_window("main")
                        .is_some_and(|window| window.is_focused().unwrap_or(false))
                    {
                        if let Some(main) = app.get_webview("main") {
                            let _ = main.set_focus();
                        }
                    }
                }
            }
        }
    });
}
fn status(app: &AppHandle, id: &str) -> Result<Value, BridgeError> {
    let view = app.get_webview(id).ok_or_else(|| error("Guest closed"))?;
    let url = view.url().map_err(|e| error(e.to_string()))?;
    let entries = app.state::<BrowserGuests>();
    let entries = entries
        .0
        .lock()
        .map_err(|_| error("Guest registry unavailable"))?;
    let guest = entries.get(id).ok_or_else(|| error("Guest closed"))?;
    Ok(
        json!({"guestId":id,"url":url.as_str(),"loading":guest.loading,
    "title":guest.title,"visible":guest.visible_until.is_some_and(|until|until>Instant::now()),
    "native":true,"width":guest.bounds.width,"height":guest.bounds.height,"documentGeneration":guest.document_generation}),
    )
}

#[tauri::command]
pub async fn desktop_browser_guest(
    app: AppHandle,
    webview: Webview,
    request: Request,
) -> Result<Value, BridgeError> {
    crate::ensure_main_webview(&webview)?;
    if app.state::<BrowserGuests>().1.load(Ordering::Acquire) {
        return Err(error("Browser window is closing"));
    }
    if !valid_id(&request.holder) {
        return Err(error("Invalid holder"));
    }
    if request.operation == "create" {
        let host = request
            .host_id
            .as_deref()
            .filter(|id| valid_id(id))
            .ok_or_else(|| error("Invalid host ID"))?;
        let bot = request
            .bot_id
            .as_deref()
            .filter(|id| valid_id(id))
            .ok_or_else(|| error("Invalid bot ID"))?;
        let url = parse_url(request.url.as_deref().unwrap_or("about:blank"))?;
        let proxy = request
            .proxy_url
            .as_deref()
            .map(|value| {
                let url = tauri::Url::parse(value).map_err(|_| error("Invalid proxy"))?;
                if url.scheme() != "http"
                    || url.host_str() != Some("127.0.0.1")
                    || url.port().is_none()
                    || url.port() == Some(0)
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(error("Proxy must be a loopback HTTP endpoint"));
                }
                Ok(url)
            })
            .transpose()?;
        // Direct and relayed pages keep distinct cookies. All live pages in a
        // renderer share the same proxy endpoint and profile.
        let profile = format!(
            "{:x}",
            Sha256::digest(format!(
                "{host}\0{bot}\0{}",
                if proxy.is_some() { "relay" } else { "direct" }
            ))
        );
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|e| error(e.to_string()))?
            .join("browser-guests")
            .join(profile);
        std::fs::create_dir_all(&directory).map_err(|e| error(e.to_string()))?;
        let id = format!("browser-guest-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        {
            let state = app.state::<BrowserGuests>();
            let mut entries = state
                .0
                .lock()
                .map_err(|_| error("Guest registry unavailable"))?;
            if state.1.load(Ordering::Acquire) {
                return Err(error("Browser window is closing"));
            }
            if entries.len() >= 16 {
                return Err(error("Too many browser guests"));
            }
            entries.insert(
                id.clone(),
                Guest {
                    holder: request.holder,
                    title: String::new(),
                    visible_until: None,
                    bounds: Bounds::INITIAL,
                    document_generation: 0,
                    loading: true,
                    mutations: Arc::new(tokio::sync::Mutex::new(())),
                    capture: Arc::new(tokio::sync::Mutex::new(())),
                },
            );
        }
        let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(parse_url("about:blank")?))
            .data_directory(directory)
            .focused(false)
            .on_navigation(allowed_url)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(|view, payload| {
                if let Ok(mut entries) = view.state::<BrowserGuests>().0.lock() {
                    if let Some(guest) = entries.get_mut(view.label()) {
                        guest.loading = payload.event() == tauri::webview::PageLoadEvent::Started;
                        if guest.loading {
                            guest.document_generation += 1;
                        }
                    }
                }
            })
            .on_document_title_changed(|view, title| {
                if let Ok(mut entries) = view.state::<BrowserGuests>().0.lock() {
                    if let Some(guest) = entries.get_mut(view.label()) {
                        guest.title = title.chars().take(1024).collect();
                    }
                }
            });
        if let Some(proxy) = proxy {
            builder = builder.proxy_url(proxy.clone());
            // Explicit args replace Wry defaults, including its proxy-server arg.
            // Preserve Wry hardening and route loopback destinations through Center too.
            #[cfg(windows)]
            {
                // Chromium's proxy flag accepts a server origin without a URL path.
                let proxy_origin = proxy.origin().ascii_serialization();
                builder = builder.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                     --proxy-server={proxy_origin} --proxy-bypass-list=<-loopback>"
                ));
            }
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| error("Main window unavailable"))?;
        // Keep unpresented guests clipped outside the client area. A hidden
        // controller cannot paint frames for the other clients.
        let created = window.add_child(
            builder,
            tauri::LogicalPosition::new(Bounds::PARKED, Bounds::PARKED),
            tauri::LogicalSize::new(Bounds::INITIAL.width, Bounds::INITIAL.height),
        );
        let view = match created {
            Ok(view) => view,
            Err(e) => {
                if let Ok(mut entries) = app.state::<BrowserGuests>().0.lock() {
                    entries.remove(&id);
                }
                return Err(error(e.to_string()));
            }
        };
        if app.state::<BrowserGuests>().1.load(Ordering::Acquire) {
            let _ = view.close();
            return Err(error("Browser window is closing"));
        }
        if let Err(failure) = view.navigate(url) {
            let _ = view.close();
            if let Ok(mut entries) = app.state::<BrowserGuests>().0.lock() {
                entries.remove(&id);
            }
            return Err(error(failure.to_string()));
        }
        return status(&app, &id);
    }
    let id = request
        .guest_id
        .as_deref()
        .ok_or_else(|| error("Missing guest ID"))?;
    let (mutations, capture) = {
        let state = app.state::<BrowserGuests>();
        let entries = state
            .0
            .lock()
            .map_err(|_| error("Guest registry unavailable"))?;
        if entries
            .get(id)
            .is_none_or(|guest| guest.holder != request.holder)
        {
            return Err(error("Guest holder mismatch"));
        }
        if request.document_generation.is_some_and(|generation| {
            entries
                .get(id)
                .is_some_and(|guest| guest.document_generation != generation)
        }) {
            return Err(error("Stale document"));
        }
        let guest = entries.get(id).ok_or_else(|| error("Guest closed"))?;
        (guest.mutations.clone(), guest.capture.clone())
    };
    // Frames and reads never hold the input/navigation queue.
    let _mutation_guard = if matches!(
        request.operation.as_str(),
        "input" | "actInput" | "act" | "navigate" | "back" | "forward" | "reload" | "close"
    ) {
        Some(mutations.lock().await)
    } else {
        None
    };
    if app.state::<BrowserGuests>().1.load(Ordering::Acquire) {
        return Err(error("Browser window is closing"));
    }
    if let Some(expected) = request.document_generation {
        let state = app.state::<BrowserGuests>();
        let entries = state
            .0
            .lock()
            .map_err(|_| error("Guest registry unavailable"))?;
        if entries
            .get(id)
            .is_none_or(|guest| guest.document_generation != expected)
        {
            return Err(error("Stale document"));
        }
    }
    let view = app.get_webview(id).ok_or_else(|| error("Guest closed"))?;
    match request.operation.as_str() {
        "status" => {
            let mut result = status(&app, id)?;
            if result["loading"] != true {
                result["domHints"] = evaluate(&view, HINTS).await?;
            }
            return Ok(result);
        }
        "layout" => {
            let b = request.bounds.ok_or_else(|| error("Missing bounds"))?;
            if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
                || b.x < 0.0
                || b.y < 0.0
                || !(1.0..=4096.0).contains(&b.width)
                || !(1.0..=4096.0).contains(&b.height)
                || b.width * b.height > 8_000_000.0
            {
                return Err(error("Invalid bounds"));
            }
            let state = app.state::<BrowserGuests>();
            let mut entries = state
                .0
                .lock()
                .map_err(|_| error("Guest registry unavailable"))?;
            let guest = entries.get_mut(id).ok_or_else(|| error("Guest closed"))?;
            let visible = guest
                .visible_until
                .is_some_and(|until| until > Instant::now());
            b.apply(&view, visible).map_err(|e| error(e.to_string()))?;
            guest.bounds = b;
        }
        "show" | "heartbeat" | "hide" => {
            let state = app.state::<BrowserGuests>();
            let mut entries = state
                .0
                .lock()
                .map_err(|_| error("Guest registry unavailable"))?;
            if request.operation == "show" {
                for (other_id, other) in entries.iter_mut() {
                    if other_id != id && other.visible_until.take().is_some() {
                        if let Some(other_view) = app.get_webview(other_id) {
                            let _ = other.bounds.apply(&other_view, false);
                        }
                    }
                }
            }
            let guest = entries.get_mut(id).ok_or_else(|| error("Guest closed"))?;
            if request.operation == "hide" {
                let visible = guest.visible_until.take().is_some();
                guest
                    .bounds
                    .apply(&view, false)
                    .map_err(|e| error(e.to_string()))?;
                drop(entries);
                if visible && view.window().is_focused().unwrap_or(false) {
                    let _ = webview.set_focus();
                }
            } else if request.operation == "show" || guest.visible_until.is_some() {
                let ttl = Duration::from_millis(
                    request
                        .ttl_ms
                        .unwrap_or(LEASE.as_millis() as u64)
                        .clamp(1, 4_000),
                );
                if request.operation == "show" {
                    guest
                        .bounds
                        .apply(&view, true)
                        .map_err(|e| error(e.to_string()))?;
                }
                guest.visible_until = Some(Instant::now() + ttl);
            }
        }
        "navigate" => view
            .navigate(parse_url(
                request.url.as_deref().ok_or_else(|| error("Missing URL"))?,
            )?)
            .map_err(|e| error(e.to_string()))?,
        "back" => {
            evaluate(&view, "history.back(); true").await?;
        }
        "forward" => {
            evaluate(&view, "history.forward(); true").await?;
        }
        "reload" => {
            evaluate(&view, "location.reload(); true").await?;
        }
        "snapshot" => {
            return evaluate(&view, &guarded(SNAPSHOT, request.expected_url.as_deref())).await
        }
        "act" => {
            let text = request.text.unwrap_or_default();
            if text.len() > 65536 {
                return Err(error("Text too long"));
            }
            let action = request.action.as_deref().unwrap_or("");
            if !matches!(
                action,
                "click" | "dblclick" | "hover" | "fill" | "focus" | "select"
            ) {
                return Err(error("Unsupported action"));
            }
            let params = json!({"action":action,"ref":request.element_ref,"text":text});
            let script = format!("({ACTION})({params})");
            return evaluate(&view, &guarded(&script, request.expected_url.as_deref())).await;
        }
        "input" | "actInput" => {
            let event = request.event.ok_or_else(|| error("Missing input event"))?;
            let guard = if request.operation == "actInput" {
                if !matches!(event["kind"].as_str(), Some("text" | "key" | "wheel")) {
                    return Err(error("Unsupported browser action input"));
                }
                FOCUSED_FIELD
            } else {
                "true"
            };
            evaluate(&view, &guarded(guard, request.expected_url.as_deref())).await?;
            if app.state::<BrowserGuests>().1.load(Ordering::Acquire) {
                return Err(error("Browser window is closing"));
            }
            return input(&view, event).await;
        }
        "waitCheck" => {
            let condition = request
                .wait
                .ok_or_else(|| error("Missing browser wait condition"))?;
            if [&condition.selector, &condition.text, &condition.url]
                .into_iter()
                .any(|value| value.as_ref().is_some_and(|text| text.len() > 512))
                || !matches!(
                    condition.state.as_deref(),
                    None | Some("visible" | "hidden")
                )
                || !matches!(
                    condition.load.as_deref(),
                    None | Some("load" | "domcontentloaded")
                )
            {
                return Err(error("Invalid browser wait condition"));
            }
            let params = serde_json::to_string(&condition).map_err(|e| error(e.to_string()))?;
            let script = format!("({WAIT_CHECK})({params})");
            return evaluate(&view, &guarded(&script, None)).await;
        }
        "frame" => {
            let _capture_guard = capture
                .try_lock()
                .map_err(|_| error("Frame capture busy; retry later"))?;
            let before = status(&app, id)?;
            evaluate(&view, &guarded("true", request.expected_url.as_deref())).await?;
            let mut result = frame(&view).await?;
            let state = status(&app, id)?;
            evaluate(&view, &guarded("true", request.expected_url.as_deref())).await?;
            if app.state::<BrowserGuests>().1.load(Ordering::Acquire) {
                return Err(error("Browser window is closing"));
            }
            if before["documentGeneration"] != state["documentGeneration"]
                || before["url"] != state["url"]
            {
                return Err(error("Document changed during capture"));
            }
            if result["data"]
                .as_str()
                .is_none_or(|data| data.len() > 720 * 1024)
            {
                return Err(error("Frame exceeds transport limit; reduce viewport"));
            }
            result["width"] = state["width"].clone();
            result["height"] = state["height"].clone();
            return Ok(result);
        }
        "close" => {
            view.close().map_err(|e| error(e.to_string()))?;
            app.state::<BrowserGuests>()
                .0
                .lock()
                .map_err(|_| error("Guest registry unavailable"))?
                .remove(id);
            return Ok(json!({"ok":true}));
        }
        _ => return Err(error("Unsupported guest operation")),
    }
    status(&app, id)
}

async fn evaluate(view: &Webview, script: &str) -> Result<Value, BridgeError> {
    let (send, receive) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let script=format!("(()=>{{try{{return {{value:(()=>{{return {script}}})()}}}}catch(e){{return {{error:String(e)}}}}}})()");
    #[cfg(not(target_os = "linux"))]
    {
        let send = Mutex::new(Some(send));
        view.eval_with_callback(script, move |raw| {
            if let Ok(mut send) = send.lock() {
                if let Some(send) = send.take() {
                    let _ = send.send(Ok(raw));
                }
            }
        })
        .map_err(|e| error(e.to_string()))?;
    }
    #[cfg(target_os = "linux")]
    view.with_webview(move |platform| {
        use javascriptcore::ValueExt;
        use webkit2gtk::WebViewExt;
        // Wry queues scripts issued before the first commit and discards their
        // callbacks. Use WebKit's callback directly for request/reply operations.
        platform.inner().evaluate_javascript(
            &script,
            None,
            None,
            None::<&gtk::gio::Cancellable>,
            move |result| {
                let result = result.map_err(|e| e.to_string()).and_then(|reply| {
                    reply
                        .to_json(0)
                        .map(|json| json.to_string())
                        .ok_or_else(|| "Invalid WebKit response".to_owned())
                });
                let _ = send.send(result);
            },
        );
    })
    .map_err(|e| error(e.to_string()))?;
    let raw = tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| error("Guest operation timed out"))?
        .map_err(|_| error("Guest closed"))?
        .map_err(error)?;
    let result: Value = serde_json::from_str(&raw).map_err(|_| error("Invalid guest response"))?;
    if let Some(message) = result.get("error") {
        return Err(error(message.to_string()));
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}
const SNAPSHOT: &str = r#"(()=>{const nodes=[...document.querySelectorAll('a,button,input,textarea,select,[role], [contenteditable=true]')].filter(e=>e.getClientRects().length).slice(0,500);window.__pibotElements=nodes;return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,32000),elements:nodes.map((e,i)=>({ref:i+1,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',type:e.type||'',text:(e.getAttribute('aria-label')||e.innerText||e.placeholder||'').slice(0,500)}))}})()"#;
const ACTION: &str = r#"p => {
    const element = window.__pibotElements?.[p.ref - 1];
    if (!element?.isConnected) throw Error('Element expired; take a new snapshot');
    const descriptor = [element.id, element.name, element.type, element.getAttribute('aria-label'), element.textContent].join(' ');
    if (/secret|password|identifier|username|consent|agree|terms|policy|authorize|allow access/i.test(descriptor))
        throw Error('Sensitive control requires user');
    if (p.action === 'click' || p.action === 'dblclick') {
        element.click();
        if (p.action === 'dblclick' && element.isConnected) {
            element.click();
            element.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2}));
        }
    } else if (p.action === 'hover') {
        element.scrollIntoView({block: 'nearest', inline: 'nearest'});
        const rect = element.getBoundingClientRect();
        const position = {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2};
        element.dispatchEvent(new MouseEvent('mouseover', {...position, bubbles: true}));
        element.dispatchEvent(new MouseEvent('mousemove', {...position, bubbles: true}));
    } else if (p.action === 'focus') {
        element.focus();
    } else {
        element.focus();
        if (p.action === 'select') {
            if (!(element instanceof HTMLSelectElement) || ![...element.options].some(option => option.value === p.text))
                throw Error('No matching option');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, p.text);
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, p.text);
        } else if (element.isContentEditable) {
            element.textContent = p.text;
        } else {
            throw Error('Element is not editable');
        }
        element.dispatchEvent(new Event('input', {bubbles: true}));
        element.dispatchEvent(new Event('change', {bubbles: true}));
    }
    return {ok: true};
}"#;

const FOCUSED_FIELD: &str = r#"(() => {
    const element = document.activeElement;
    if (element?.matches('input, textarea, button, select, [contenteditable=true]') &&
        /secret|password|identifier|username|consent|agree|terms|policy|authorize|allow access/i.test(
            [element.id, element.name, element.type, element.getAttribute('aria-label'), element.textContent].join(' ')))
        throw Error('Sensitive control requires user');
    return true;
})()"#;

const WAIT_CHECK: &str = r#"condition => {
    if (condition.load === 'load' && document.readyState !== 'complete') return {ok: false};
    if (condition.load === 'domcontentloaded' && document.readyState === 'loading') return {ok: false};
    if (condition.url && !location.href.includes(condition.url)) return {ok: false};
    if (condition.text && !(document.body?.innerText ?? '').includes(condition.text)) return {ok: false};
    if (condition.selector) {
        const visible = [...document.querySelectorAll(condition.selector)]
            .some(element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
        if (visible === (condition.state === 'hidden')) return {ok: false};
    }
    return {ok: true};
}"#;

const HINTS: &str = r#"(()=>{const visible=e=>e.getClientRects().length>0;const fields=[...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(visible);const descriptor=e=>[e.id,e.name,e.autocomplete,e.getAttribute('aria-label')].join(' ').toLowerCase();return {hasPasswordInput:fields.some(e=>e.type==='password'),hasOtpInput:fields.some(e=>/one-time-code|otp|verification.?code|security.?code/.test(descriptor(e))),clientSecretVisible:fields.some(e=>/client.?secret|api.?key|private.?key/.test(descriptor(e))),hasPolicyCheckbox:fields.some(e=>e.type==='checkbox'&&/consent|policy|terms|agree/.test(descriptor(e))),hasIdentifierInput:fields.some(e=>e.type==='email'||/identifier|username/.test(descriptor(e)))}})()"#;
fn guarded(script: &str, expected: Option<&str>) -> String {
    let expected = serde_json::to_string(&expected).unwrap_or_else(|_| "null".into());
    format!("(()=>{{const expected={expected};if(expected!==null&&location.href!==expected)throw Error('Stale document URL');const hints={HINTS};if(Object.values(hints).some(Boolean))throw Error('Sensitive page requires user control');return ({script})}})()")
}

async fn frame(view: &Webview) -> Result<Value, BridgeError> {
    let (send, receive) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    #[cfg(windows)]
    view.with_webview(move |platform| {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows_core::{HSTRING, PCWSTR};
        let send = std::sync::Arc::new(Mutex::new(Some(send)));
        let reply = send.clone();
        let callback =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
                let result = status
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str::<Value>(&json).map_err(|e| e.to_string()))
                    .map(|v| json!({"data":v["data"],"mimeType":"image/jpeg"}));
                if let Ok(mut reply) = reply.lock() {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(result);
                    }
                }
                Ok(())
            }));
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|core| {
                core.CallDevToolsProtocolMethod(
                    PCWSTR(HSTRING::from("Page.captureScreenshot").as_ptr()),
                    PCWSTR(
                        HSTRING::from(
                            r#"{"format":"jpeg","quality":65,"captureBeyondViewport":false}"#,
                        )
                        .as_ptr(),
                    ),
                    &callback,
                )
            })
        };
        if let Err(e) = result {
            if let Ok(mut send) = send.lock() {
                if let Some(send) = send.take() {
                    let _ = send.send(Err(e.to_string()));
                }
            }
        }
    })
    .map_err(|e| error(e.to_string()))?;
    #[cfg(target_os = "linux")]
    {
        let runtime = tokio::runtime::Handle::current();
        view.with_webview(move |platform| {
        use webkit2gtk::WebViewExt;
        platform.inner().snapshot(
            webkit2gtk::SnapshotRegion::Visible,
            webkit2gtk::SnapshotOptions::NONE,
            None::<&gtk::gio::Cancellable>,
            move |surface| {
                let pixbuf = surface.map_err(|e| e.to_string()).and_then(snapshot_rgb);
                match pixbuf {
                    Ok(pixels) => {
                        runtime.spawn_blocking(move || {
                            use base64::Engine;
                            use gtk::gdk_pixbuf::{Colorspace, Pixbuf};
                            let (bytes, width, height, rowstride) = pixels;
                            let pixbuf = Pixbuf::from_bytes(&bytes, Colorspace::Rgb, false, 8, width, height, rowstride);
                            let result = pixbuf.save_to_bufferv("jpeg", &[("quality", "65")])
                                .map(|bytes| json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes),"mimeType":"image/jpeg"}))
                                .map_err(|e| e.to_string());
                            let _ = send.send(result);
                        });
                    }
                    Err(e) => { let _ = send.send(Err(e)); }
                }
            }
        );
    }).map_err(|e|error(e.to_string()))?;
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = send.send(Err(
            "Native screenshot is unavailable on this platform".into()
        ));
    }
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| error("Frame timed out"))?
        .map_err(|_| error("Guest closed"))?
        .map_err(error)
}

#[cfg(target_os = "linux")]
fn snapshot_rgb(surface: gtk::cairo::Surface) -> Result<(gtk::glib::Bytes, i32, i32, i32), String> {
    use gtk::cairo::{Context, Format, ImageSurface};
    let image = ImageSurface::try_from(surface).map_err(|e| e.to_string())?;
    let (width, height) = (image.width(), image.height());
    let opaque = ImageSurface::create(Format::Rgb24, width, height).map_err(|e| e.to_string())?;
    let context = Context::new(&opaque).map_err(|e| e.to_string())?;
    context.set_source_rgb(1.0, 1.0, 1.0);
    context.paint().map_err(|e| e.to_string())?;
    context
        .set_source_surface(&image, 0.0, 0.0)
        .map_err(|e| e.to_string())?;
    context.paint().map_err(|e| e.to_string())?;
    let pixbuf = gtk::gdk::pixbuf_get_from_surface(&opaque, 0, 0, width, height)
        .ok_or("Empty GTK snapshot")?;
    Ok((pixbuf.read_pixel_bytes(), width, height, pixbuf.rowstride()))
}

async fn input(view: &Webview, event: Value) -> Result<Value, BridgeError> {
    let kind = event["kind"]
        .as_str()
        .ok_or_else(|| error("Missing input kind"))?;
    if !matches!(
        kind,
        "click" | "dblclick" | "move" | "wheel" | "key" | "text"
    ) {
        return Err(error("Unsupported input kind"));
    }
    for field in ["x", "y"] {
        if let Some(value) = event.get(field) {
            if !value
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))
            {
                return Err(error("Input coordinates must be normalized"));
            }
        }
    }
    for field in ["deltaX", "deltaY"] {
        if let Some(value) = event.get(field) {
            if !value
                .as_f64()
                .is_some_and(|v| v.is_finite() && v.abs() <= 10000.0)
            {
                return Err(error("Invalid wheel delta"));
            }
        }
    }
    if event["text"].as_str().unwrap_or("").len() > 65536
        || event["key"].as_str().unwrap_or("").len() > 64
    {
        return Err(error("Input too long"));
    }
    #[cfg(windows)]
    {
        let modifiers =
            event["modifiers"]
                .as_array()
                .into_iter()
                .flatten()
                .fold(0u8, |bits, modifier| {
                    bits | match modifier.as_str() {
                        Some("Alt") => 1,
                        Some("Control") => 2,
                        Some("Meta") => 4,
                        Some("Shift") => 8,
                        _ => 0,
                    }
                });
        if kind == "text" {
            cdp(
                view,
                "Input.insertText",
                json!({"text":event["text"].as_str().unwrap_or("")}),
            )
            .await?;
        } else if kind == "key" {
            let key = browser_key_name(event["key"].as_str().unwrap_or(""));
            let mut chars = key.chars();
            let single = chars.next().filter(|_| chars.next().is_none());
            let virtual_code = match key {
                "Enter" => 13,
                "Tab" => 9,
                "Backspace" => 8,
                "Escape" => 27,
                "Delete" => 46,
                "ArrowLeft" => 37,
                "ArrowUp" => 38,
                "ArrowRight" => 39,
                "ArrowDown" => 40,
                "Home" => 36,
                "End" => 35,
                "PageUp" => 33,
                "PageDown" => 34,
                "Insert" => 45,
                _ => function_key(key)
                    .map(|number| 111 + number)
                    .or_else(|| {
                        single
                            .filter(char::is_ascii)
                            .map(|character| character.to_ascii_uppercase() as u32)
                    })
                    .unwrap_or(0),
            };
            if virtual_code == 0 && single.is_none() {
                return Err(error("Unsupported control key; use text input"));
            }
            cdp(
                view,
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled":true}),
            )
            .await?;
            let text = if modifiers & 7 != 0 {
                ""
            } else if key == "Enter" {
                "\r"
            } else if single.is_some() {
                key
            } else {
                ""
            };
            let code = match single {
                Some(c) if c.is_ascii_alphabetic() => format!("Key{}", c.to_ascii_uppercase()),
                Some(c) if c.is_ascii_digit() => format!("Digit{c}"),
                Some(' ') => "Space".into(),
                Some(_) => String::new(),
                None => key.into(),
            };
            cdp(view,"Input.dispatchKeyEvent",json!({"type":"keyDown","key":key,"code":code,"windowsVirtualKeyCode":virtual_code,"nativeVirtualKeyCode":virtual_code,"text":text,"unmodifiedText":text,"modifiers":modifiers})).await?;
            cdp(view,"Input.dispatchKeyEvent",json!({"type":"keyUp","key":key,"code":code,"windowsVirtualKeyCode":virtual_code,"nativeVirtualKeyCode":virtual_code,"modifiers":modifiers})).await?;
        } else {
            let viewport = evaluate(view, "({width:innerWidth,height:innerHeight})").await?;
            let x = event["x"].as_f64().unwrap_or(0.5) * viewport["width"].as_f64().unwrap_or(1.0);
            let y = event["y"].as_f64().unwrap_or(0.5) * viewport["height"].as_f64().unwrap_or(1.0);
            let button = match event["button"].as_str().unwrap_or("left") {
                "left" => "left",
                "right" => "right",
                "middle" => "middle",
                _ => return Err(error("Invalid mouse button")),
            };
            if kind == "wheel" {
                cdp(view,"Input.dispatchMouseEvent",json!({"type":"mouseWheel","x":x,"y":y,"deltaX":event["deltaX"].as_f64().unwrap_or(0.0),"deltaY":event["deltaY"].as_f64().unwrap_or(0.0),"modifiers":modifiers})).await?;
            } else if kind == "move" {
                cdp(
                    view,
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseMoved","x":x,"y":y}),
                )
                .await?;
            } else {
                let count = if kind == "dblclick" {
                    2
                } else {
                    event["count"].as_u64().unwrap_or(1).clamp(1, 2)
                };
                for click_count in 1..=count {
                    for phase in ["mousePressed", "mouseReleased"] {
                        cdp(view, "Input.dispatchMouseEvent",
                            json!({"type":phase,"x":x,"y":y,"button":button,"clickCount":click_count,"modifiers":modifiers}))
                            .await?;
                    }
                }
            }
        }
        return Ok(json!({"ok":true}));
    }
    #[cfg(not(windows))]
    {
        if kind == "key" {
            #[cfg(target_os = "linux")]
            return gtk_key(view, event).await;
            #[cfg(not(target_os = "linux"))]
            return Err(error(
                "Native control-key injection is unavailable on this platform",
            ));
        }
        evaluate(view, &format!("({DOM_INPUT})({event})")).await
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn browser_key_name(key: &str) -> &str {
    match key {
        "Space" => " ",
        "Left" => "ArrowLeft",
        "Right" => "ArrowRight",
        "Up" => "ArrowUp",
        "Down" => "ArrowDown",
        key => key,
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn function_key(key: &str) -> Option<u32> {
    key.strip_prefix('F')?
        .parse::<u32>()
        .ok()
        .filter(|number| (1..=12).contains(number))
}

#[cfg(target_os = "linux")]
async fn gtk_key(view: &Webview, input: Value) -> Result<Value, BridgeError> {
    use gtk::gdk::prelude::SeatExt;
    use gtk::gdk::{self, keys::constants, ModifierType};
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::WidgetExt;
    let name = browser_key_name(input["key"].as_str().unwrap_or(""));
    let key = match name {
        "Enter" => constants::Return,
        "Tab" => constants::Tab,
        "Backspace" => constants::BackSpace,
        "Escape" => constants::Escape,
        "Delete" => constants::Delete,
        "ArrowLeft" => constants::Left,
        "ArrowUp" => constants::Up,
        "ArrowRight" => constants::Right,
        "ArrowDown" => constants::Down,
        "Home" => constants::Home,
        "End" => constants::End,
        "PageUp" => constants::Page_Up,
        "PageDown" => constants::Page_Down,
        "Insert" => constants::Insert,
        name if function_key(name).is_some() => gdk::keys::Key::from_name(name),
        name => {
            let mut chars = name.chars();
            let point = chars
                .next()
                .filter(|c| !c.is_control() && chars.next().is_none())
                .ok_or_else(|| error("Unsupported control key; use text input"))?
                as u32;
            gdk::keys::Key::from(if point <= 0xff {
                point
            } else {
                0x0100_0000 | point
            })
        }
    };
    let modifiers = input["modifiers"].as_array().into_iter().flatten().fold(
        ModifierType::empty(),
        |bits, modifier| {
            bits | match modifier.as_str() {
                Some("Alt") => ModifierType::MOD1_MASK,
                Some("Control") => ModifierType::CONTROL_MASK,
                Some("Meta") => ModifierType::META_MASK,
                Some("Shift") => ModifierType::SHIFT_MASK,
                _ => ModifierType::empty(),
            }
        },
    );
    let (send, receive) = tokio::sync::oneshot::channel::<Result<(), String>>();
    view.with_webview(move |platform| {
        let view = platform.inner();
        let result = (|| {
            let window = view.window().ok_or("WebKit window unavailable")?;
            let display = view.display();
            let keyboard = display.default_seat().and_then(|seat| seat.keyboard());
            let keymap = gdk::Keymap::for_display(&display).ok_or("Keyboard map unavailable")?;
            let entries = keymap.entries_for_keyval(*key);
            let entry = entries.first().ok_or("Key not present in keyboard map")?;
            for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
                let mut event = gdk::Event::new(kind);
                // Event::new owns a correctly typed union and releases the
                // window reference on drop. GTK takes a borrowed event.
                unsafe {
                    let native = &mut (*event.as_ptr()).key;
                    native.window = window.to_glib_full();
                    native.keyval = *key;
                    native.hardware_keycode = entry.keycode() as u16;
                    native.group = entry.group() as u8;
                    native.state = modifiers.bits();
                    native.send_event = 1;
                }
                event.set_device(keyboard.as_ref());
                view.event(&event);
            }
            Ok(())
        })();
        let _ = send.send(result.map_err(str::to_owned));
    })
    .map_err(|e| error(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| error("Native input timed out"))?
        .map_err(|_| error("Guest closed"))?
        .map_err(error)?;
    Ok(json!({"ok":true}))
}
#[cfg(not(windows))]
const DOM_INPUT: &str = r#"p=>{const x=(p.x??0.5)*innerWidth,y=(p.y??0.5)*innerHeight;const e=p.kind==='text'?document.activeElement:document.elementFromPoint(x,y);if(!e)throw Error('No input target');if(p.kind==='text'){if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))throw Error('Target is not editable');const start=e.selectionStart??e.value.length,end=e.selectionEnd??start;e.setRangeText(p.text||'',start,end,'end');e.dispatchEvent(new Event('input',{bubbles:true}))}else if(p.kind==='wheel'){let target=e;while(target&&target!==document.documentElement&&target.scrollHeight<=target.clientHeight)target=target.parentElement;(target||document.documentElement).scrollBy(p.deltaX||0,p.deltaY||0)}else if(p.kind==='move'){e.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}))}else{e.focus();e.click();if(p.kind==='dblclick'){e.click();e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:x,clientY:y}))}}return {ok:true}}"#;

#[cfg(windows)]
async fn cdp(view: &Webview, method: &'static str, params: Value) -> Result<Value, BridgeError> {
    let (send, receive) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    view.with_webview(move |platform| {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows_core::{HSTRING, PCWSTR};
        let send = std::sync::Arc::new(Mutex::new(Some(send)));
        let reply = send.clone();
        let callback =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
                let result = status
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str::<Value>(&json).map_err(|e| e.to_string()));
                if let Ok(mut reply) = reply.lock() {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(result);
                    }
                }
                Ok(())
            }));
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|core| {
                core.CallDevToolsProtocolMethod(
                    PCWSTR(HSTRING::from(method).as_ptr()),
                    PCWSTR(HSTRING::from(params.to_string()).as_ptr()),
                    &callback,
                )
            })
        };
        if let Err(e) = result {
            if let Ok(mut send) = send.lock() {
                if let Some(send) = send.take() {
                    let _ = send.send(Err(e.to_string()));
                }
            }
        }
    })
    .map_err(|e| error(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| error("Native input timed out"))?
        .map_err(|_| error("Guest closed"))?
        .map_err(error)
}
