package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.os.Binder;
import android.view.Display;
import com.ai.assistance.shower.IShowerService;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowDisplayManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ShowerLifecycleTest {
    @Test public void defaultCreateUsesCurrentFullDefaultDisplayMetricsInLandscape() throws Exception {
        ShadowDisplayManager.changeDisplay(Display.DEFAULT_DISPLAY,
                "w1920dp-h822dp-land-xhdpi");
        ShowerToolBridge tools = new ShowerToolBridge(RuntimeEnvironment.getApplication());
        int[] requested = new int[4];
        Binder binder = new Binder();
        IShowerService service = (IShowerService) Proxy.newProxyInstance(
                IShowerService.class.getClassLoader(), new Class<?>[]{IShowerService.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "asBinder": return binder;
                        case "ensureDisplay":
                            for (int index = 0; index < requested.length; index++) {
                                requested[index] = (Integer) args[index];
                            }
                            return 7;
                        case "attachClient":
                        case "touchDisplay":
                        case "tap": return true;
                        default: throw new AssertionError("Unexpected Binder call: " + method.getName());
                    }
                });
        Field managerField = ShowerToolBridge.class.getDeclaredField("manager");
        managerField.setAccessible(true);
        Field serviceField = ShowerManager.class.getDeclaredField("service");
        serviceField.setAccessible(true);
        serviceField.set(managerField.get(tools), service);

        JSONObject created = tools.executeOwner("chat", new JSONObject().put("action", "create"));
        assertArrayEquals(new int[]{3840, 1648, 320, 500}, requested);
        assertEquals(3840, created.getInt("width"));
        assertEquals(1648, created.getInt("height"));
        assertEquals(320, created.getInt("dpi"));
        JSONObject tapped = tools.executeOwner("chat", new JSONObject().put("action", "tap")
                .put("x", 3839).put("y", 1647));
        assertEquals(3839, tapped.getInt("x"));
        assertEquals(1647, tapped.getInt("y"));
    }

    @Test public void chatOwnershipReuseReleaseAndExpiredDisplayRecovery() throws Exception {
        ShowerToolBridge tools = new ShowerToolBridge(RuntimeEnvironment.getApplication());
        Set<Integer> active = new HashSet<>();
        AtomicInteger nextId = new AtomicInteger(10);
        Binder binder = new Binder();
        IShowerService service = (IShowerService) Proxy.newProxyInstance(
                IShowerService.class.getClassLoader(), new Class<?>[]{IShowerService.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "asBinder": return binder;
                        case "ensureDisplay":
                            int id = nextId.incrementAndGet();
                            active.add(id);
                            return id;
                        case "attachClient":
                        case "touchDisplay": return active.contains((Integer) args[0]);
                        case "destroyDisplay": return active.remove((Integer) args[0]);
                        case "injectKeyWithMeta":
                            assertTrue("Input must target an existing nonzero display", active.contains((Integer) args[0]));
                            return true;
                        default: throw new AssertionError("Unexpected Binder call: " + method.getName());
                    }
                });
        Field managerField = ShowerToolBridge.class.getDeclaredField("manager");
        managerField.setAccessible(true);
        Object manager = managerField.get(tools);
        Field serviceField = ShowerManager.class.getDeclaredField("service");
        serviceField.setAccessible(true);
        serviceField.set(manager, service);

        JSONObject create = new JSONObject().put("action", "create");
        assertThrows(IllegalArgumentException.class, () -> tools.executeOwner(null, create));
        int a = tools.executeOwner("chat-a", create).getInt("displayId");
        int b = tools.executeOwner("chat-b", create).getInt("displayId");
        assertNotEquals(a, b);
        assertEquals(Set.of(a, b), active);
        assertTrue(tools.executeOwner("chat-a", create).getBoolean("reused"));
        assertEquals(300_000, tools.executeOwner("chat-b", create).getInt("idleTimeoutMs"));

        // Model-supplied IDs cannot redirect release to another conversation.
        tools.executeOwner("chat-a", new JSONObject().put("action", "release")
                .put("conversationId", "chat-b").put("displayId", b));
        assertEquals(Set.of(b), active);
        assertSame("Releasing one screen must not stop the shared service", service, serviceField.get(manager));
        JSONObject key = new JSONObject().put("action", "key").put("key", "BACK");
        assertEquals(b, tools.executeOwner("chat-b", key).getInt("displayId"));

        a = tools.executeOwner("chat-a", create).getInt("displayId");
        active.remove(a); // Server reclaimed this chat's idle display while another chat stayed active.
        assertThrows(IllegalStateException.class, () -> tools.executeOwner("chat-a", key));
        assertEquals(b, tools.executeOwner("chat-b", key).getInt("displayId"));
        JSONObject recreated = tools.executeOwner("chat-a", create);
        assertFalse(recreated.getBoolean("reused"));
        assertNotEquals(a, recreated.getInt("displayId"));

        active.remove(recreated.getInt("displayId"));
        assertFalse("create must also recover expiry without a preceding failed input",
                tools.executeOwner("chat-a", create).getBoolean("reused"));
        tools.forgetConversation("chat-a");
        assertEquals(Set.of(b), active);
        tools.forgetConversation("chat-b");
        assertTrue(active.isEmpty());
    }
}
