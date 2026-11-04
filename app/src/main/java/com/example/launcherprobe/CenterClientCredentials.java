package com.example.launcherprobe;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One backup-excluded center client credential, encrypted independently of Host credentials. */
final class CenterClientCredentials {
    private static final String ALIAS = "center_client.credentials.v1";
    private final AtomicFile file;

    CenterClientCredentials(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "center_client_credentials_v1.json"));
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            if (!create) throw new IllegalStateException("中心凭据密钥不可用");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }

    JSONObject read() throws Exception {
        File base = file.getBaseFile();
        if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return null;
        JSONObject encrypted = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false),
                new GCMParameterSpec(128, Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP)));
        JSONObject record = new JSONObject(new String(cipher.doFinal(Base64.decode(
                encrypted.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
        record.getString("url");
        record.getString("deviceId");
        record.getString("deviceToken");
        // Older connections omitted the optional CA field.
        if (!record.has("ca")) record.put("ca", "");
        record.getString("ca");
        return record;
    }

    void save(JSONObject record) throws Exception {
        if (!record.has("ca")) record.put("ca", "");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        JSONObject encrypted = new JSONObject()
                .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(cipher.doFinal(
                        record.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        FileOutputStream stream = file.startWrite();
        try {
            stream.write(encrypted.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(stream);
        } catch (Exception failure) {
            file.failWrite(stream);
            throw failure;
        }
    }

    void clear() throws Exception {
        file.delete();
        File base = file.getBaseFile();
        if (base.exists() || new File(base.getPath() + ".bak").exists()) {
            throw new IOException("无法清除中心凭据");
        }
    }

    static JSONObject metadata(JSONObject record) throws Exception {
        return new JSONObject().put("url", record.getString("url"))
                .put("deviceId", record.getString("deviceId")).put("ca", record.getString("ca"));
    }
}
