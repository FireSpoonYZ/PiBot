package com.example.launcherprobe;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Objects;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Backup-excluded, atomic, AES-GCM encrypted local persistence for Android clipboard sync
 * switch and group code. Uses its own AndroidKeyStore alias (independent of Host and Center
 * credential aliases) with no plaintext fallback, and scopes state strictly to the active
 * Center origin, device ID, and credential fingerprint so binding changes never migrate a group.
 */
final class ClipboardSyncStorage {

    static final String KEY_ALIAS = "clipboard_sync.state.v1";
    static final String FILE_NAME = "clipboard_sync_state_v1.json";
    private static final int ENVELOPE_VERSION = 1;
    private static final int SCHEMA_VERSION = 1;

    static final class Binding {
        final String origin;
        final String deviceId;
        final String credentialFingerprint;

        Binding(String origin, String deviceId, String credentialFingerprint) {
            if (origin == null || origin.isEmpty()
                    || deviceId == null || deviceId.isEmpty()
                    || credentialFingerprint == null || credentialFingerprint.isEmpty()) {
                throw new IllegalArgumentException("中心绑定信息无效");
            }
            this.origin = origin;
            this.deviceId = deviceId;
            this.credentialFingerprint = credentialFingerprint;
        }

        static Binding create(String origin, String deviceId, String deviceToken, String caPem) {
            String normalizedOrigin = normalizeOrigin(origin);
            String normalizedDeviceId = deviceId == null ? "" : deviceId.trim();
            String token = deviceToken == null ? "" : deviceToken;
            String ca = caPem == null ? "" : caPem.trim();
            if (normalizedOrigin.isEmpty() || normalizedDeviceId.isEmpty() || token.isEmpty()) {
                throw new IllegalArgumentException("中心凭据不完整");
            }
            String fingerprint = sha256Hex(normalizedOrigin + "\0" + normalizedDeviceId + "\0" + token + "\0" + ca);
            return new Binding(normalizedOrigin, normalizedDeviceId, fingerprint);
        }

        String bindingKey() {
            return credentialFingerprint;
        }

        boolean matches(String otherOrigin, String otherDeviceId, String otherFingerprint) {
            if (otherOrigin == null || otherDeviceId == null || otherFingerprint == null) {
                return false;
            }
            if (!origin.equals(otherOrigin) || !deviceId.equals(otherDeviceId)) {
                return false;
            }
            return MessageDigest.isEqual(
                    credentialFingerprint.getBytes(StandardCharsets.UTF_8),
                    otherFingerprint.getBytes(StandardCharsets.UTF_8));
        }
    }

    static final class State {
        private static final State EMPTY = new State(false, null, false);

        final boolean enabled;
        final String groupCode;
        final boolean backgroundAuthorized;

        State(boolean enabled, String groupCode) {
            this(enabled, groupCode, false);
        }

        State(boolean enabled, String groupCode, boolean backgroundAuthorized) {
            this.enabled = enabled;
            this.groupCode = (groupCode == null || groupCode.isEmpty()) ? null : groupCode;
            this.backgroundAuthorized = backgroundAuthorized;
        }

        static State empty() {
            return EMPTY;
        }

        boolean isConfigured() {
            return groupCode != null && !groupCode.isEmpty();
        }
    }

    static final class EncryptedPayload {
        final byte[] iv;
        final byte[] ciphertext;

        EncryptedPayload(byte[] iv, byte[] ciphertext) {
            this.iv = Objects.requireNonNull(iv);
            this.ciphertext = Objects.requireNonNull(ciphertext);
        }
    }

    interface CipherBox {
        EncryptedPayload encrypt(byte[] plaintext) throws Exception;

        byte[] decrypt(byte[] iv, byte[] ciphertext) throws Exception;
    }

    private static final class AndroidKeyStoreCipherBox implements CipherBox {
        private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
        private static final String TRANSFORMATION = "AES/GCM/NoPadding";
        private static final int GCM_TAG_BITS = 128;

        private SecretKey key(boolean create) throws Exception {
            KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
            store.load(null);
            if (!store.containsAlias(KEY_ALIAS)) {
                if (!create) {
                    throw new IllegalStateException("剪贴板同步密钥不可用");
                }
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
                generator.init(new KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build());
                return generator.generateKey();
            }
            SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (existing == null) {
                throw new IllegalStateException("剪贴板同步密钥不可用");
            }
            return existing;
        }

        @Override
        public EncryptedPayload encrypt(byte[] plaintext) throws Exception {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] ciphertext = cipher.doFinal(plaintext);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length == 0) {
                throw new IllegalStateException("加密参数无效");
            }
            return new EncryptedPayload(iv, ciphertext);
        }

        @Override
        public byte[] decrypt(byte[] iv, byte[] ciphertext) throws Exception {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return cipher.doFinal(ciphertext);
        }
    }

    private final Path file;
    private final CipherBox cipherBox;

    ClipboardSyncStorage(Context context) {
        this(new File(context.getNoBackupFilesDir(), FILE_NAME), new AndroidKeyStoreCipherBox());
    }

    ClipboardSyncStorage(File targetFile, CipherBox cipherBox) {
        this.file = Objects.requireNonNull(targetFile).toPath();
        this.cipherBox = Objects.requireNonNull(cipherBox);
    }

    synchronized State readForBinding(Binding binding) throws IOException {
        if (binding == null) {
            return State.empty();
        }
        if (Files.notExists(file)) {
            return State.empty();
        }
        try {
            byte[] raw = Files.readAllBytes(file);
            JSONObject envelope = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (envelope.getInt("v") != ENVELOPE_VERSION) {
                throw new IOException("剪贴板同步存储版本不受支持");
            }
            byte[] iv = Base64.getDecoder().decode(envelope.getString("iv"));
            byte[] ciphertext = Base64.getDecoder().decode(envelope.getString("ciphertext"));
            byte[] plaintext = cipherBox.decrypt(iv, ciphertext);
            JSONObject record = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
            if (record.getInt("version") != SCHEMA_VERSION) {
                throw new IOException("剪贴板同步状态版本不受支持");
            }
            String origin = record.getString("origin");
            String deviceId = record.getString("deviceId");
            String fingerprint = record.getString("credentialFingerprint");
            if (!binding.matches(origin, deviceId, fingerprint)) {
                return State.empty();
            }
            boolean enabled = record.getBoolean("enabled");
            String groupCode = record.isNull("groupCode") ? null : record.optString("groupCode", null);
            boolean backgroundAuthorized = record.optBoolean("backgroundAuthorized", false);
            return new State(enabled, groupCode, backgroundAuthorized);
        } catch (Exception failure) {
            // Never log secrets/ciphertext or fall back to plaintext.
            throw new IOException("剪贴板同步状态读取失败");
        }
    }

    synchronized void saveForBinding(Binding binding, boolean enabled, String groupCode) throws IOException {
        saveForBinding(binding, enabled, groupCode, false);
    }

    synchronized void saveForBinding(Binding binding, boolean enabled, String groupCode,
                                     boolean backgroundAuthorized) throws IOException {
        if (binding == null) {
            throw new IllegalArgumentException("中心绑定不可用");
        }
        byte[] encodedEnvelope;
        try {
            JSONObject record = new JSONObject()
                    .put("version", SCHEMA_VERSION)
                    .put("origin", binding.origin)
                    .put("deviceId", binding.deviceId)
                    .put("credentialFingerprint", binding.credentialFingerprint)
                    .put("enabled", enabled)
                    .put("groupCode", (groupCode == null || groupCode.isEmpty()) ? JSONObject.NULL : groupCode)
                    .put("backgroundAuthorized", backgroundAuthorized);
            EncryptedPayload encrypted = cipherBox.encrypt(record.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject()
                    .put("v", ENVELOPE_VERSION)
                    .put("iv", Base64.getEncoder().encodeToString(encrypted.iv))
                    .put("ciphertext", Base64.getEncoder().encodeToString(encrypted.ciphertext));
            encodedEnvelope = envelope.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception failure) {
            // Never fall back to plaintext if AndroidKeyStore / cipher fails.
            throw new IOException("剪贴板同步状态加密失败");
        }
        try {
            Path staged = Files.createTempFile(file.toAbsolutePath().getParent(), ".clipboard-sync-", ".tmp");
            try {
                try (FileOutputStream stream = new FileOutputStream(staged.toFile())) {
                    stream.write(encodedEnvelope);
                    stream.getFD().sync();
                }
                // Report rename failures; AtomicFile.finishWrite can report success with stale state.
                Files.move(staged, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(staged);
            }
        } catch (IOException failure) {
            throw new IOException("剪贴板同步状态保存失败");
        }
    }

    synchronized void clear() throws IOException {
        try {
            Files.deleteIfExists(file);
        } catch (IOException failure) {
            throw new IOException("剪贴板同步状态清除失败");
        }
    }

    static String normalizeOrigin(String url) {
        if (url == null) {
            return "";
        }
        String trimmed = url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static String sha256Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            char[] out = new char[digest.length * 2];
            for (int i = 0; i < digest.length; i++) {
                int v = digest[i] & 0xff;
                out[i * 2] = HEX[v >>> 4];
                out[i * 2 + 1] = HEX[v & 0x0f];
            }
            return new String(out);
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }
}
