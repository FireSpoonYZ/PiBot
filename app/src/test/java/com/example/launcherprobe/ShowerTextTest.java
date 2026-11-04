package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.ClipboardManager;
import android.content.Context;
import android.os.Binder;
import android.view.KeyEvent;
import com.ai.assistance.shower.IShowerService;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ShowerTextTest {
    @Test public void unicodeReplacementClipboardAndClearStayOnVirtualDisplay() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        ClipboardManager clipboard = context.getSystemService(ClipboardManager.class);
        ShowerController controller = new ShowerController(context, new ShowerManager(context));
        List<String> keys = new ArrayList<>();
        Binder binder = new Binder();
        IShowerService service = (IShowerService) Proxy.newProxyInstance(
                IShowerService.class.getClassLoader(), new Class<?>[]{IShowerService.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("asBinder")) return binder;
                    if (method.getName().equals("touchDisplay") || method.getName().equals("hasDisplay")) {
                        assertEquals(7, args[0]);
                        return true;
                    }
                    if (method.getName().equals("getDisplaySize")) {
                        assertEquals(7, args[0]);
                        return new int[]{720, 1280};
                    }
                    if (!method.getName().equals("injectKeyWithMeta")) {
                        throw new AssertionError("Unexpected Binder call: " + method.getName());
                    }
                    assertEquals(7, args[0]);
                    keys.add(args[1] + ":" + args[2]);
                    return true;
                });
        Field manager = ShowerController.class.getDeclaredField("manager");
        manager.setAccessible(true);
        set(manager.get(controller), "service", service);
        set(controller, "displayService", binder);
        set(controller, "displayId", 7);
        set(controller, "width", 720);
        set(controller, "height", 1280);

        String unicode = "不要做挑战\n你好 👋";
        controller.text(unicode);
        assertEquals(unicode, clipboard.getPrimaryClip().getItemAt(0).getText().toString());
        assertEquals(List.of(KeyEvent.KEYCODE_A + ":" + KeyEvent.META_CTRL_ON,
                KeyEvent.KEYCODE_PASTE + ":0"), keys);

        keys.clear();
        controller.text("");
        assertEquals(List.of(KeyEvent.KEYCODE_A + ":" + KeyEvent.META_CTRL_ON,
                KeyEvent.KEYCODE_DEL + ":0"), keys);
        assertEquals("Clearing the field must not erase the clipboard", unicode,
                clipboard.getPrimaryClip().getItemAt(0).getText().toString());

        keys.clear();
        controller.copy("复制测试");
        assertTrue("Copy must not type into the input field", keys.isEmpty());
        controller.paste();
        assertEquals(List.of(KeyEvent.KEYCODE_PASTE + ":0"), keys);
        assertEquals("复制测试", clipboard.getPrimaryClip().getItemAt(0).getText().toString());

        clipboard.clearPrimaryClip();
        keys.clear();
        controller.paste();
        assertEquals("The focused target handles the clipboard; the host need not read it",
                List.of(KeyEvent.KEYCODE_PASTE + ":0"), keys);
        set(controller, "displayId", null);
        assertThrows(IllegalStateException.class, () -> controller.copy("不能落到主屏"));
        assertFalse(clipboard.hasPrimaryClip());
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
