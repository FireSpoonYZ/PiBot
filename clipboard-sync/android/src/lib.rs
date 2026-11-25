use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use clipboard_sync::{eligible_text, GroupKey};
use clipboard_sync_relay_client::{IncomingClip, Link, LinkConfig, LinkStatus};
use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::{JNIEnv, JavaVM};
use tokio::runtime::{Builder, Runtime};

// Never derive Debug on any state/value type in this crate so secrets,
// group codes, device tokens, and clipboard text cannot be formatted.

struct CallbackGate {
    active: AtomicBool,
    receiver: Mutex<Option<GlobalRef>>,
}

impl CallbackGate {
    fn new(receiver: GlobalRef) -> Self {
        Self {
            active: AtomicBool::new(true),
            receiver: Mutex::new(Some(receiver)),
        }
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    fn clone_receiver_if_active(&self) -> Option<GlobalRef> {
        if !self.is_active() {
            return None;
        }
        let guard = self.receiver.lock().unwrap_or_else(|e| e.into_inner());
        if !self.is_active() {
            return None;
        }
        guard.as_ref().cloned()
    }

    fn revoke(&self) {
        self.active.store(false, Ordering::SeqCst);
        let dropped = {
            let mut guard = self.receiver.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        drop(dropped);
    }
}

struct ActiveLink {
    handle: i64,
    link: Link,
    gate: Arc<CallbackGate>,
}

impl ActiveLink {
    fn teardown(self) {
        // Invalidate callbacks and drop the GlobalRef on the caller thread
        // before cancelling/dropping the relay link.
        self.gate.revoke();
        drop(self.link);
    }
}

struct LinkState {
    next_handle: i64,
    current: Option<ActiveLink>,
}

impl LinkState {
    const fn new() -> Self {
        Self {
            next_handle: 1,
            current: None,
        }
    }

    fn allocate_handle(&mut self) -> i64 {
        let handle = self.next_handle;
        self.next_handle = if handle == i64::MAX { 1 } else { handle + 1 };
        handle
    }
}

static STATE: Mutex<LinkState> = Mutex::new(LinkState::new());
static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();

fn runtime() -> Option<&'static Runtime> {
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(1)
                .max_blocking_threads(2)
                .enable_all()
                .thread_name("pibot-clip-sync")
                .build()
                .ok()
        })
        .as_ref()
}

fn lock_state() -> std::sync::MutexGuard<'static, LinkState> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn clear_exception(env: &JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
}

fn read_required_string(env: &mut JNIEnv<'_>, value: &JString<'_>) -> Option<String> {
    if value.is_null() {
        return None;
    }
    match env.get_string(value) {
        Ok(s) => Some(String::from(s)),
        Err(_) => {
            clear_exception(env);
            None
        }
    }
}

fn read_optional_string(env: &mut JNIEnv<'_>, value: &JString<'_>) -> Result<Option<String>, ()> {
    if value.is_null() {
        return Ok(None);
    }
    match env.get_string(value) {
        Ok(s) => {
            let text = String::from(s);
            if text.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(text))
            }
        }
        Err(_) => {
            clear_exception(env);
            Err(())
        }
    }
}

fn deliver_clip(jvm: &JavaVM, gate: &CallbackGate, clip: IncomingClip) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !gate.is_active() {
            return;
        }
        let Ok(generation) = i64::try_from(clip.generation) else {
            return;
        };
        if generation <= 0 {
            return;
        }
        let Ok(mut env) = jvm.attach_current_thread() else {
            return;
        };
        // Declared after `env` so any final `GlobalRef` drop runs while still attached.
        let Some(receiver) = gate.clone_receiver_if_active() else {
            return;
        };
        let _ = env.with_local_frame(8, |env| -> jni::errors::Result<()> {
            if !gate.is_active() {
                return Ok(());
            }
            if let Ok(jtext) = env.new_string(&clip.text) {
                let _ = env.call_method(
                    receiver.as_obj(),
                    "onText",
                    "(JLjava/lang/String;)V",
                    &[JValue::Long(generation), JValue::Object(&jtext)],
                );
            }
            clear_exception(env);
            Ok(())
        });
        clear_exception(&env);
    }));
}

fn current_status(handle: i64) -> LinkStatus {
    if handle <= 0 {
        return LinkStatus::Offline;
    }
    let state = lock_state();
    match &state.current {
        Some(active) if active.handle == handle => active.link.snapshot().status,
        _ => LinkStatus::Offline,
    }
}

fn current_online_generation(handle: i64) -> i64 {
    if handle <= 0 {
        return 0;
    }
    let state = lock_state();
    match &state.current {
        Some(active) if active.handle == handle => {
            let snap = active.link.snapshot();
            if snap.status == LinkStatus::Online {
                i64::try_from(snap.generation)
                    .ok()
                    .filter(|&generation| generation > 0)
                    .unwrap_or(0)
            } else {
                0
            }
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_generateGroupCode<
    'local,
>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jstring {
    catch_unwind(AssertUnwindSafe(move || {
        let Ok(key) = GroupKey::generate() else {
            return ptr::null_mut();
        };
        let code = key.to_code();
        match env.new_string(&code) {
            Ok(jstr) => jstr.into_raw(),
            Err(_) => {
                clear_exception(&env);
                ptr::null_mut()
            }
        }
    }))
    .unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_validGroupCode<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    code: JString<'local>,
) -> jboolean {
    catch_unwind(AssertUnwindSafe(move || {
        let Some(code) = read_required_string(&mut env, &code) else {
            return JNI_FALSE;
        };
        if GroupKey::from_code(&code).is_ok() {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }))
    .unwrap_or(JNI_FALSE)
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_start<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    origin: JString<'local>,
    device_id: JString<'local>,
    token: JString<'local>,
    ca_pem: JString<'local>,
    code: JString<'local>,
    receiver: JObject<'local>,
) -> jlong {
    catch_unwind(AssertUnwindSafe(move || {
        if receiver.is_null() {
            return 0;
        }
        let Some(origin) = read_required_string(&mut env, &origin) else {
            return 0;
        };
        let Some(device_id) = read_required_string(&mut env, &device_id) else {
            return 0;
        };
        let Some(device_token) = read_required_string(&mut env, &token) else {
            return 0;
        };
        let Ok(ca_pem) = read_optional_string(&mut env, &ca_pem) else {
            return 0;
        };
        let Some(code) = read_required_string(&mut env, &code) else {
            return 0;
        };
        if origin.trim().is_empty() || device_id.trim().is_empty() || device_token.trim().is_empty()
        {
            return 0;
        }
        let Ok(key) = GroupKey::from_code(&code) else {
            return 0;
        };
        let Ok(jvm) = env.get_java_vm() else {
            clear_exception(&env);
            return 0;
        };
        let Ok(receiver_ref) = env.new_global_ref(&receiver) else {
            clear_exception(&env);
            return 0;
        };
        let Some(rt) = runtime() else {
            drop(receiver_ref);
            return 0;
        };

        // Ensure at most one link is active at a time by tearing down any prior link
        // outside the state lock before starting the replacement.
        let prior = {
            let mut state = lock_state();
            state.current.take()
        };
        if let Some(prev) = prior {
            prev.teardown();
        }

        let gate = Arc::new(CallbackGate::new(receiver_ref));
        let callback_gate = Arc::clone(&gate);
        let config = LinkConfig {
            origin,
            device_id,
            device_token,
            ca_pem,
        };

        let link = {
            let _enter = rt.enter();
            clipboard_sync_relay_client::start(config, key, move |clip| {
                deliver_clip(&jvm, &callback_gate, clip);
            })
        };

        let Ok(link) = link else {
            gate.revoke();
            return 0;
        };

        let (handle, displaced) = {
            let mut state = lock_state();
            let handle = state.allocate_handle();
            let displaced = state.current.replace(ActiveLink { handle, link, gate });
            (handle, displaced)
        };
        if let Some(prev) = displaced {
            prev.teardown();
        }
        handle
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_status<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
) -> jstring {
    catch_unwind(AssertUnwindSafe(move || {
        let status = current_status(handle);
        match env.new_string(status.as_str()) {
            Ok(jstr) => jstr.into_raw(),
            Err(_) => {
                clear_exception(&env);
                ptr::null_mut()
            }
        }
    }))
    .unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_onlineGeneration<
    'local,
>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
) -> jlong {
    catch_unwind(AssertUnwindSafe(move || current_online_generation(handle))).unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_send<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
    generation: jlong,
    text: JString<'local>,
) -> jboolean {
    catch_unwind(AssertUnwindSafe(move || {
        if handle <= 0 || generation <= 0 || text.is_null() {
            return JNI_FALSE;
        }
        let Some(text) = read_required_string(&mut env, &text) else {
            return JNI_FALSE;
        };
        if !eligible_text(&text) {
            return JNI_FALSE;
        }
        let state = lock_state();
        let sent = match &state.current {
            Some(active) if active.handle == handle => {
                active.link.publish(generation as u64, &text)
            }
            _ => false,
        };
        if sent {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }))
    .unwrap_or(JNI_FALSE)
}

#[no_mangle]
pub extern "system" fn Java_com_example_launcherprobe_ClipboardSyncNative_stop<'local>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    let _ = catch_unwind(AssertUnwindSafe(move || {
        if handle <= 0 {
            return;
        }
        let removed = {
            let mut state = lock_state();
            match &state.current {
                Some(active) if active.handle == handle => state.current.take(),
                _ => None,
            }
        };
        if let Some(active) = removed {
            active.teardown();
        }
    }));
}
