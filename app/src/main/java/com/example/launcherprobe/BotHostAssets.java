package com.example.launcherprobe;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 安装并校验 bot-host 运行时资产，重建私有可执行链接。
 * 仅在显式进程启动时调用，冷状态从不触发 prepare。
 */
final class BotHostAssets {

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern SEGMENT = Pattern.compile("^[A-Za-z0-9._-]+$");
    private static final String ASSET_ROOT = "bot-host";
    private static final String MANIFEST_ASSET = ASSET_ROOT + "/payload.json";
    private static final String RUNTIME_ENTRY = "host-runtime.mjs";

    final File root;
    final File state;
    final File home;
    final File bin;
    final File workspace;
    final File entry;

    private BotHostAssets(File root, File state, File home, File bin, File workspace, File entry) {
        this.root = root;
        this.state = state;
        this.home = home;
        this.bin = bin;
        this.workspace = workspace;
        this.entry = entry;
    }

    static synchronized BotHostAssets prepare(Context context) throws IOException {
        File files = context.getFilesDir();
        File root = new File(files, ASSET_ROOT);
        File state = new File(root, "state");
        File home = new File(root, "home");
        File bin = new File(root, "bin");
        File workspace = new File(root, "workspaces");
        File runtime = new File(root, "runtime");
        File[] dirs = {
                root, state, home, new File(home, "tmp"), bin, workspace, runtime,
                new File(home, ".pi/agent")
        };
        for (File dir : dirs) {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建 bot-host 目录：" + dir);
        }

        JSONObject manifest = readManifest(context);
        String versionSha;
        JSONArray fileList;
        try {
            versionSha = manifest.getString("sha256");
            fileList = manifest.getJSONArray("files");
        } catch (JSONException e) {
            throw new IOException("bot-host 清单损坏");
        }
        File versioned = new File(runtime, versionSha);
        File marker = new File(versioned, "complete.txt");
        if (marker.isFile()) {
            // 完整版本损坏时不得删除（可能在运行），直接报资产错误。
            if (!verifyVersion(versioned, marker, versionSha, fileList)) {
                throw new IOException("bot-host 运行时版本校验失败");
            }
        } else {
            // 仅不完整安装才允许删除并重装该版本目录。
            install(context, versioned, marker, fileList, versionSha);
            if (!verifyVersion(versioned, marker, versionSha, fileList)) {
                throw new IOException("bot-host 版本安装后校验失败");
            }
        }
        File entry = new File(versioned, RUNTIME_ENTRY);
        if (!entry.isFile()) throw new IOException("host runtime 缺失：" + RUNTIME_ENTRY);
        // Node 读取该脚本，不需要执行位；应要求的原生可执行文件另有 canExecute 校验。
        if (!entry.canRead()) throw new IOException("host runtime 不可读：" + RUNTIME_ENTRY);

        ensureLink(context, bin, "node", "libnode_launcher.so");
        ensureLink(context, bin, "rg", "libhost_rg.so");
        ensureLink(context, bin, "fd", "libhost_fd.so");

        return new BotHostAssets(root, state, home, bin, workspace, entry);
    }

    /** Install the bundled npm distribution without touching the user's Node home. */
    static synchronized void prepareNpm(Context context, File home) throws IOException {
        String version = "11.6.2";
        File root = new File(home, "npm"), target = new File(root, version);
        if (!new File(target, "payload-complete.txt").isFile() || !new File(target, "bin/npm-cli.js").isFile()) {
            File temporary = new File(root, "." + version + "-installing");
            deleteTree(temporary);
            try {
                copyAssets(context, "npm/" + version, temporary);
                if (!new File(temporary, "payload-complete.txt").isFile() || !new File(temporary, "bin/npm-cli.js").isFile())
                    throw new IOException("内置 npm 资源不完整");
                deleteTree(target);
                if (!temporary.renameTo(target)) throw new IOException("无法启用内置 npm");
            } catch (IOException failure) {
                deleteTree(temporary);
                throw failure;
            }
        }
        File bin = new File(home, "bin");
        if (!bin.isDirectory() && !bin.mkdirs()) throw new IOException("无法创建 Node 命令目录");
        File launcher = new File(context.getApplicationInfo().nativeLibraryDir, "libnode_launcher.so");
        if (!launcher.isFile()) throw new IOException("内置 Node 启动器缺失");
        File node = new File(bin, "node");
        if (Files.exists(node.toPath(), LinkOption.NOFOLLOW_LINKS)
                && !node.getCanonicalFile().equals(launcher.getCanonicalFile())) Files.delete(node.toPath());
        try {
            if (!node.exists()) android.system.Os.symlink(launcher.getAbsolutePath(), node.getAbsolutePath());
        } catch (android.system.ErrnoException failure) {
            throw new IOException("无法修复 Node 链接", failure);
        }
    }

    private static void copyAssets(Context context, String source, File target) throws IOException {
        String[] entries = context.getAssets().list(source);
        if (entries != null && entries.length > 0) {
            if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法创建 npm 资源目录");
            for (String entry : entries) copyAssets(context, source + "/" + entry, new File(target, entry));
        } else {
            try (InputStream input = context.getAssets().open(source);
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[16_384];
                for (int count; (count = input.read(buffer)) >= 0;) output.write(buffer, 0, count);
            }
        }
    }

    private static JSONObject readManifest(Context context) throws IOException {
        String text;
        try (InputStream in = context.getAssets().open(MANIFEST_ASSET)) {
            text = new String(readAll(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IOException("bot-host 清单缺失");
        }
        JSONObject manifest;
        try {
            // 严格解析：取完整单一文档，拒绝尾随垃圾。
            JSONTokener tokener = new JSONTokener(text);
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) || tokener.nextClean() != 0) {
                throw new IOException("bot-host 清单损坏");
            }
            manifest = (JSONObject) value;
        } catch (JSONException e) {
            throw new IOException("bot-host 清单损坏");
        }
        try {
            if (manifest.optLong("version") != 1L) throw new IOException("bot-host 清单版本不支持");
            String sha = manifest.optString("sha256");
            if (!SHA256.matcher(sha).matches()) throw new IOException("bot-host 清单哈希无效");
            JSONArray fileList = manifest.getJSONArray("files");
            if (fileList.length() == 0) throw new IOException("bot-host 清单无文件");
            boolean hasEntry = false;
            List<String[]> entries = new ArrayList<>();
            for (int i = 0; i < fileList.length(); i++) {
                JSONObject item = fileList.getJSONObject(i);
                String path = item.getString("path");
                String fileSha = item.getString("sha256");
                validatePath(path);
                if (!SHA256.matcher(fileSha).matches()) throw new IOException("bot-host 清单文件哈希无效");
                if (RUNTIME_ENTRY.equals(path)) hasEntry = true;
                entries.add(new String[]{path, fileSha});
            }
            if (!hasEntry) throw new IOException("bot-host 清单缺少 " + RUNTIME_ENTRY);
            // 聚合摘要：按路径排序，path + NUL + fileSha + 换行 累积后 SHA-256。
            MessageDigest aggregate;
            try {
                aggregate = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("无 SHA-256");
            }
            Collections.sort(entries, (a, b) -> a[0].compareTo(b[0]));
            for (String[] pair : entries) {
                aggregate.update(pair[0].getBytes(StandardCharsets.UTF_8));
                aggregate.update((byte) 0);
                aggregate.update(pair[1].getBytes(StandardCharsets.UTF_8));
                aggregate.update((byte) '\n');
            }
            if (!hex(aggregate.digest()).equals(sha)) throw new IOException("bot-host 清单聚合摘要不匹配");
            return manifest;
        } catch (JSONException e) {
            throw new IOException("bot-host 清单损坏");
        }
    }

    private static boolean verifyVersion(File versioned, File marker, String versionSha, JSONArray fileList)
            throws IOException {
        if (!marker.isFile()) return false;
        try {
            String markerText;
            try (InputStream in = Files.newInputStream(marker.toPath())) {
                markerText = new String(readAll(in), StandardCharsets.UTF_8).trim();
            }
            if (!versionSha.equals(markerText)) return false;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (int i = 0; i < fileList.length(); i++) {
                JSONObject item = fileList.getJSONObject(i);
                File file = new File(versioned, item.getString("path"));
                if (!file.isFile()) return false;
                digest.reset();
                try (InputStream in = Files.newInputStream(file.toPath())) {
                    digest.update(readAll(in));
                }
                if (!hex(digest.digest()).equals(item.getString("sha256"))) return false;
            }
            return true;
        } catch (IOException | JSONException | NoSuchAlgorithmException e) {
            return false;
        }
    }

    private static void install(Context context, File versioned, File marker, JSONArray fileList, String versionSha)
            throws IOException {
        if (versioned.exists()) deleteTree(versioned);
        if (!versioned.mkdirs()) throw new IOException("无法创建运行时版本目录");
        try {
            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("无 SHA-256");
            }
            for (int i = 0; i < fileList.length(); i++) {
                JSONObject item = fileList.getJSONObject(i);
                String path = item.getString("path");
                String expect = item.getString("sha256");
                File dest = new File(versioned, path);
                File parent = dest.getParentFile();
                if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建运行时子目录：" + path);
                digest.reset();
                try (InputStream in = context.getAssets().open(ASSET_ROOT + "/" + path);
                     FileOutputStream out = new FileOutputStream(dest)) {
                    byte[] buffer = new byte[16_384];
                    for (int count; (count = in.read(buffer)) >= 0; ) {
                        out.write(buffer, 0, count);
                        digest.update(buffer, 0, count);
                    }
                }
                if (!hex(digest.digest()).equals(expect)) throw new IOException("bot-host 资源校验失败：" + path);
            }
            // 全部复制并校验成功后才写完成标记；失败路径整体删除该版本。
            try (FileOutputStream out = new FileOutputStream(marker)) {
                out.write((versionSha + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (JSONException e) {
            deleteTree(versioned);
            throw new IOException("bot-host 清单损坏");
        } catch (Throwable t) {
            deleteTree(versioned);
            if (t instanceof IOException) throw (IOException) t;
            throw new IOException("安装 bot-host 失败");
        }
    }

    private static void ensureLink(Context context, File bin, String name, String soName) throws IOException {
        File target = new File(context.getApplicationInfo().nativeLibraryDir, soName);
        if (!target.isFile()) throw new IOException("缺少内置 " + soName);
        if (!target.canExecute()) throw new IOException("内置 " + soName + " 不可执行");
        File link = new File(bin, name);
        try {
            // APK 更换会改变 nativeLibraryDir；NOFOLLOW_LINKS 也能发现悬空旧链接。
            if (Files.exists(link.toPath(), LinkOption.NOFOLLOW_LINKS)
                    && !link.getCanonicalFile().equals(target.getCanonicalFile())) {
                Files.delete(link.toPath());
            }
            if (!link.exists()) android.system.Os.symlink(target.getAbsolutePath(), link.getAbsolutePath());
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("无法修复符号链接 " + name);
        }
    }

    private static void validatePath(String path) throws IOException {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\")
                || path.indexOf('\u0000') >= 0) {
            throw new IOException("bot-host 清单路径无效");
        }
        for (String segment : path.split("/")) {
            if (!SEGMENT.matcher(segment).matches()) throw new IOException("bot-host 清单路径无效：" + path);
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[16_384];
        for (int count; (count = in.read(buffer)) >= 0; ) out.write(buffer, 0, count);
        return out.toByteArray();
    }

    /** 不跟随符号链接递归清理，仅删除链接本身。 */
    private static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        Path path = file.toPath();
        if (Files.isSymbolicLink(path)) {
            Files.delete(path);
            return;
        }
        if (Files.isDirectory(path)) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        Files.delete(path);
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
