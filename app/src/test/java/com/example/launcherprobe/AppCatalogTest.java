package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPackageManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public class AppCatalogTest {
    @Test public void listsEveryInstalledAppAndSearchesLabelOrPackageIgnoringCase() throws Exception {
        PackageManager packages = RuntimeEnvironment.getApplication().getPackageManager();
        ShadowPackageManager shadow = Shadows.shadowOf(packages);
        install(shadow, "com.vendor.maps", "Road MAPS", ApplicationInfo.FLAG_SYSTEM);
        install(shadow, "org.example.camera", "Lens", 0);
        for (int index = 0; index < 205; index++) {
            install(shadow, String.format("test.bulk.%03d", index), "Bulk " + index, 0);
        }
        AppCatalog catalog = new AppCatalog(RuntimeEnvironment.getApplication());

        JSONArray listed = catalog.execute(new JSONObject().put("action", "list"));
        int bulkCount = 0;
        for (int index = 0; index < listed.length(); index++) {
            JSONObject app = listed.getJSONObject(index);
            if (app.getString("packageName").startsWith("test.bulk.")) bulkCount++;
            assertEquals(2, app.length());
            assertTrue(app.has("label"));
            assertTrue(app.has("packageName"));
        }
        assertEquals("the full catalog must not stop at 200", 205, bulkCount);
        assertTrue("the fixture intentionally has no launcher activity",
                packages.queryIntentActivities(new Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_LAUNCHER), 0).stream()
                        .noneMatch(app -> "com.vendor.maps".equals(app.activityInfo.packageName)));
        assertMatch(catalog, " mApS ", "com.vendor.maps");
        assertMatch(catalog, "VENDOR.MA", "com.vendor.maps");
        assertMatch(catalog, "lEnS", "org.example.camera");
        assertThrows(IllegalArgumentException.class,
                () -> catalog.execute(new JSONObject().put("action", "search").put("query", "  ")));
    }

    private static void assertMatch(AppCatalog catalog, String query, String packageName) throws Exception {
        JSONArray result = catalog.execute(new JSONObject().put("action", "search").put("query", query));
        assertEquals(1, result.length());
        assertEquals(packageName, result.getJSONObject(0).getString("packageName"));
    }

    private static void install(ShadowPackageManager packages, String packageName, String label, int flags) {
        ApplicationInfo application = new ApplicationInfo();
        application.packageName = packageName;
        application.nonLocalizedLabel = label;
        application.flags = flags;
        PackageInfo info = new PackageInfo();
        info.packageName = packageName;
        info.applicationInfo = application;
        packages.installPackage(info);
    }
}
