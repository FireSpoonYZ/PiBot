package com.example.launcherprobe;

import android.content.Context;
import android.os.Binder;
import android.os.Process;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** Shizuku operations restricted to this app's Shower server. */
public final class OwnPermissionService extends IOwnPermissionService.Stub {
    private static final Pattern HANDOFF_TOKEN = Pattern.compile("[a-f0-9-]{36}");
    private final Context context;
    private final int appUid;
    private final String packageName;

    public OwnPermissionService(Context context) {
        this.context = context;
        appUid = context.getApplicationInfo().uid;
        packageName = context.getPackageName();
    }

    @Override
    public String startShowerServer(String handoffToken) {
        enforceAppCaller();
        if (handoffToken == null || !HANDOFF_TOKEN.matcher(handoffToken).matches()) {
            return "Invalid Shower handoff token";
        }
        try {
            File root = showerRoot();
            Files.createDirectories(root.toPath());
            String stopped = stopOwnedShower(root);
            if (!stopped.isEmpty()) return stopped;
            File jar = new File(root, "shower-server.jar");
            File staging = new File(root, ".shower-server.jar.installing");
            try (InputStream input = context.getAssets().open("shower-server.jar");
                 FileOutputStream output = new FileOutputStream(staging)) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) != -1; ) output.write(buffer, 0, count);
            }
            Files.move(staging.toPath(), jar.toPath(), StandardCopyOption.REPLACE_EXISTING);
            File log = new File(root, "server.log");
            File pidFile = new File(root, "server.pid");
            String command = "CLASSPATH=" + jar.getAbsolutePath()
                    + " /system/bin/app_process / com.ai.assistance.shower.Main " + packageName
                    + " " + appUid + " " + handoffToken + " " + log.getAbsolutePath()
                    + " >>" + log.getAbsolutePath() + " 2>&1 </dev/null & echo $! >"
                    + pidFile.getAbsolutePath();
            java.lang.Process starter = new ProcessBuilder("/system/bin/sh", "-c", command)
                    .redirectErrorStream(true).start();
            if (!starter.waitFor(5, TimeUnit.SECONDS) || starter.exitValue() != 0) {
                starter.destroyForcibly();
                return "Unable to issue Shower server start command";
            }
            Thread.sleep(250);
            if (ownedPid(root) == 0) return "Shower server exited during startup: " + tail(log);
            return "";
        } catch (Exception exception) {
            return exception.getClass().getSimpleName() + ": " + exception.getMessage();
        }
    }

    @Override
    public String stopShowerServer() {
        enforceAppCaller();
        try {
            return stopOwnedShower(showerRoot());
        } catch (Exception exception) {
            return exception.getClass().getSimpleName() + ": " + exception.getMessage();
        }
    }

    private File showerRoot() {
        return new File("/data/local/tmp/e-launcher-shower-" + appUid);
    }

    private static String stopOwnedShower(File root) throws Exception {
        int pid = ownedPid(root);
        if (pid == 0) return "";
        java.lang.Process kill = new ProcessBuilder("/system/bin/kill", Integer.toString(pid))
                .redirectErrorStream(true).start();
        if (!kill.waitFor(5, TimeUnit.SECONDS) || kill.exitValue() != 0) {
            kill.destroyForcibly();
            return "Unable to stop owned Shower server PID " + pid;
        }
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        while (ownedPid(root) != 0 && android.os.SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(50);
        }
        if (ownedPid(root) != 0) return "Owned Shower server did not stop";
        Files.deleteIfExists(new File(root, "server.pid").toPath());
        return "";
    }

    private static int ownedPid(File root) throws Exception {
        File marker = new File(root, "server.pid");
        if (!marker.isFile()) return 0;
        int pid;
        try {
            pid = Integer.parseInt(new String(Files.readAllBytes(marker.toPath()),
                    StandardCharsets.US_ASCII).trim());
        } catch (NumberFormatException exception) {
            Files.deleteIfExists(marker.toPath());
            return 0;
        }
        File process = new File("/proc/" + pid);
        if (pid <= 1 || !process.isDirectory()) return 0;
        String expectedClasspath = "CLASSPATH=" + new File(root, "shower-server.jar").getAbsolutePath() + "\0";
        try {
            String environment = new String(Files.readAllBytes(new File(process, "environ").toPath()),
                    StandardCharsets.ISO_8859_1);
            if (environment.contains(expectedClasspath)) return pid;
        } catch (Exception ignored) { }
        return 0;
    }

    private void enforceAppCaller() {
        if (Binder.getCallingUid() != appUid) throw new SecurityException("Caller is not this app");
    }

    private static String tail(File file) {
        if (!file.isFile()) return "no server log";
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            return new String(bytes, Math.max(0, bytes.length - 4000), Math.min(bytes.length, 4000),
                    StandardCharsets.UTF_8).trim();
        } catch (Exception exception) {
            return "server log unavailable";
        }
    }

    @Override
    public void destroy() {
        int caller = Binder.getCallingUid();
        if (caller != appUid && caller != 0 && caller != Process.SHELL_UID) {
            throw new SecurityException("Caller cannot destroy service");
        }
        System.exit(0);
    }
}
