package com.example.launcherprobe;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;
import android.os.Process;
import android.os.RemoteException;
import android.view.MotionEvent;
import android.view.Surface;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 新 Host Bot 屏幕服务（默认进程）：把 :tauri_ui 传来的 Surface 接到该 Bot 已有的 Shower 虚拟屏，
 * 并在用户接管后转发触摸。不创建屏幕、不启动 Host/Shizuku/Shower；Host 未运行时只报告无屏幕。
 * 这是 Android Shower 平台在统一「图形工作环境」抽象下的本机实现（见 web/src/screen）。
 */
public final class BotScreenService extends Service {
    private static final String PLATFORM = "android-shower";

    private final Map<IBinder, Viewer> viewers = new ConcurrentHashMap<>();

    private final class Viewer implements IBinder.DeathRecipient {
        final IBinder token;
        final String botId;
        final ShowerController controller;
        final ShowerController.Preview preview;
        final Surface surface;

        Viewer(IBinder token, String botId, ShowerController controller,
                ShowerController.Preview preview, Surface surface) {
            this.token = token;
            this.botId = botId;
            this.controller = controller;
            this.preview = preview;
            this.surface = surface;
        }

        @Override public void binderDied() {
            detachViewer(token);
        }
    }

    private final IBotScreen.Stub binder = new IBotScreen.Stub() {
        @Override public String status(String botId) throws RemoteException {
            enforceCaller();
            JSONObject result = object("exists", false, "platform", PLATFORM);
            ShowerController controller = controller(botId);
            int[] size;
            try {
                size = controller == null ? null : controller.displaySize();
            } catch (RemoteException dead) {
                size = null; // Shower 断开：按无屏幕报告，不把 RemoteException 抛回 UI 进程。
            }
            if (size != null) {
                put(result, "exists", true);
                put(result, "width", size[0]);
                put(result, "height", size[1]);
                put(result, "dpi", size[2]);
            }
            return result.toString();
        }

        @Override public String attach(String botId, Surface surface, IBinder viewer) throws RemoteException {
            enforceCaller();
            if (viewer == null || surface == null) throw new IllegalArgumentException("缺少预览画面");
            detachViewer(viewer);
            ShowerController controller = controller(botId);
            boolean exists;
            try {
                exists = controller != null && controller.hasDisplay();
            } catch (RemoteException dead) {
                exists = false;
            }
            if (!exists) {
                surface.release();
                throw new IllegalStateException("该 Bot 当前没有屏幕");
            }
            ShowerController.Preview preview;
            try {
                preview = controller.openPreview(surface);
            } catch (IllegalStateException | IllegalArgumentException e) {
                surface.release();
                throw e;
            } catch (Exception e) {
                surface.release();
                throw new IllegalStateException("无法连接 Bot 屏幕画面");
            }
            Viewer entry = new Viewer(viewer, botId, controller, preview, surface);
            try {
                viewer.linkToDeath(entry, 0);
            } catch (RemoteException dead) {
                closeQuietly(entry);
                throw new IllegalStateException("界面已结束");
            }
            viewers.put(viewer, entry);
            return object("width", preview.width, "height", preview.height, "platform", PLATFORM).toString();
        }

        @Override public void detach(IBinder viewer) {
            enforceCaller();
            detachViewer(viewer);
        }

        @Override public boolean keepAlive(IBinder viewer) {
            enforceCaller();
            Viewer entry = viewer == null ? null : viewers.get(viewer);
            if (entry == null) return false;
            boolean alive;
            try {
                alive = entry.controller.keepPreviewAlive(entry.preview);
            } catch (Exception e) {
                alive = false;
            }
            if (!alive) detachViewer(viewer);
            return alive;
        }

        @Override public String takeover(IBinder viewer) {
            enforceCaller();
            Viewer entry = viewer == null ? null : viewers.get(viewer);
            if (entry == null) throw new IllegalStateException("画面未连接");
            // 先中断在途屏幕动作；controller.takeover 取得控制器锁即确认 Agent 动作已停止。
            BotHostNativeTools tools = BotHostManager.get(BotScreenService.this).currentNativeTools();
            if (tools != null) tools.interruptShower(entry.botId);
            entry.controller.takeover(entry.preview);
            return object("userControl", true).toString();
        }

        @Override public void touch(IBinder viewer, MotionEvent event) {
            if (Binder.getCallingUid() != Process.myUid() || event == null) return;
            try {
                Viewer entry = viewer == null ? null : viewers.get(viewer);
                if (entry != null) entry.controller.userTouch(entry.preview, event);
            } catch (Exception ignored) {
                // oneway 无回执：画面结束或未接管时丢弃，UI 由 keepAlive/status 获知状态。
            } finally {
                event.recycle();
            }
        }
    };

    @Override public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override public boolean onUnbind(Intent intent) {
        detachAll();
        return false;
    }

    @Override public void onDestroy() {
        detachAll();
        super.onDestroy();
    }

    private ShowerController controller(String botId) {
        if (botId == null || botId.isEmpty() || botId.length() > 256) {
            throw new IllegalArgumentException("botId 无效");
        }
        BotHostNativeTools tools = BotHostManager.get(this).currentNativeTools();
        return tools == null ? null : tools.screenController(botId);
    }

    private void detachViewer(IBinder token) {
        if (token == null) return;
        Viewer entry = viewers.remove(token);
        if (entry == null) return;
        try { token.unlinkToDeath(entry, 0); }
        catch (RuntimeException ignored) { }
        closeQuietly(entry);
    }

    private void detachAll() {
        for (IBinder token : viewers.keySet()) detachViewer(token);
    }

    private static void closeQuietly(Viewer entry) {
        try { entry.controller.closePreview(entry.preview); }
        catch (Exception ignored) { /* 已释放或服务断开的屏幕无需再解绑。 */ }
        entry.surface.release();
    }

    private static void enforceCaller() {
        if (Binder.getCallingUid() != Process.myUid()) throw new SecurityException("仅限本应用");
    }

    private static JSONObject object(Object... values) {
        JSONObject result = new JSONObject();
        for (int i = 0; i + 1 < values.length; i += 2) put(result, String.valueOf(values[i]), values[i + 1]);
        return result;
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
