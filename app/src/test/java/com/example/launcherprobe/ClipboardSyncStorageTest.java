package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Verifies encrypted, atomic, binding-scoped persistence for Android clipboard sync
 * with own AndroidKeyStore alias and zero plaintext fallback.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClipboardSyncStorageTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private static ClipboardSyncStorage.CipherBox newAesGcmBox() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        SecretKey key = generator.generateKey();
        SecureRandom random = new SecureRandom();
        return new ClipboardSyncStorage.CipherBox() {
            @Override
            public ClipboardSyncStorage.EncryptedPayload encrypt(byte[] plaintext) throws Exception {
                byte[] iv = new byte[12];
                random.nextBytes(iv);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
                return new ClipboardSyncStorage.EncryptedPayload(iv, cipher.doFinal(plaintext));
            }

            @Override
            public byte[] decrypt(byte[] iv, byte[] ciphertext) throws Exception {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                return cipher.doFinal(ciphertext);
            }
        };
    }

    @Test
    public void usesDistinctKeyStoreAlias() {
        assertEquals("clipboard_sync.state.v1", ClipboardSyncStorage.KEY_ALIAS);
        assertNotEquals("center_client.credentials.v1", ClipboardSyncStorage.KEY_ALIAS);
    }

    @Test
    public void persistsEncryptedStateAndNeverWritesPlaintextToDisk() throws Exception {
        File file = new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME);
        ClipboardSyncStorage storage = new ClipboardSyncStorage(file, newAesGcmBox());
        ClipboardSyncStorage.Binding binding = ClipboardSyncStorage.Binding.create(
                "https://center.example.com/", "device-alpha", "secret-device-token-123", "-----BEGIN CERT-----");

        String groupCode = "GROUP-SECRET-CODE-XYZ-9876";
        storage.saveForBinding(binding, true, groupCode);

        assertTrue(file.exists());
        String rawOnDisk = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        assertFalse(rawOnDisk.contains(groupCode));
        assertFalse(rawOnDisk.contains("center.example.com"));
        assertFalse(rawOnDisk.contains("device-alpha"));
        assertFalse(rawOnDisk.contains("secret-device-token-123"));
        assertFalse(rawOnDisk.contains(binding.credentialFingerprint));

        // Same binding (even without trailing slash) reads back cleanly.
        ClipboardSyncStorage.Binding sameBinding = ClipboardSyncStorage.Binding.create(
                "https://center.example.com", "device-alpha", "secret-device-token-123", "-----BEGIN CERT-----");
        ClipboardSyncStorage.State loaded = storage.readForBinding(sameBinding);
        assertTrue(loaded.enabled);
        assertTrue(loaded.isConfigured());
        assertEquals(groupCode, loaded.groupCode);
    }

    @Test
    public void bindingChangesNeverSilentlyMigrateGroupOrSwitch() throws Exception {
        File file = new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME);
        ClipboardSyncStorage storage = new ClipboardSyncStorage(file, newAesGcmBox());
        ClipboardSyncStorage.Binding original = ClipboardSyncStorage.Binding.create(
                "https://center-a.example.com", "dev-1", "token-1", "ca-1");
        storage.saveForBinding(original, true, "GROUP-CODE-AAA");

        // Different Center URL
        ClipboardSyncStorage.State diffOrigin = storage.readForBinding(ClipboardSyncStorage.Binding.create(
                "https://center-b.example.com", "dev-1", "token-1", "ca-1"));
        assertFalse(diffOrigin.enabled);
        assertFalse(diffOrigin.isConfigured());
        assertNull(diffOrigin.groupCode);

        // Different deviceId
        ClipboardSyncStorage.State diffDevice = storage.readForBinding(ClipboardSyncStorage.Binding.create(
                "https://center-a.example.com", "dev-2", "token-1", "ca-1"));
        assertFalse(diffDevice.enabled);
        assertFalse(diffDevice.isConfigured());
        assertNull(diffDevice.groupCode);

        // Different deviceToken (credential fingerprint changed)
        ClipboardSyncStorage.State diffToken = storage.readForBinding(ClipboardSyncStorage.Binding.create(
                "https://center-a.example.com", "dev-1", "token-2", "ca-1"));
        assertFalse(diffToken.enabled);
        assertFalse(diffToken.isConfigured());
        assertNull(diffToken.groupCode);

        // Different CA PEM (credential fingerprint changed)
        ClipboardSyncStorage.State diffCa = storage.readForBinding(ClipboardSyncStorage.Binding.create(
                "https://center-a.example.com", "dev-1", "token-1", "ca-2"));
        assertFalse(diffCa.enabled);
        assertFalse(diffCa.isConfigured());
        assertNull(diffCa.groupCode);

        // Null binding returns empty without touching disk
        ClipboardSyncStorage.State nullBinding = storage.readForBinding(null);
        assertFalse(nullBinding.enabled);
        assertFalse(nullBinding.isConfigured());
    }

    @Test
    public void cipherFailureRefusesPlaintextFallback() throws Exception {
        File file = new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME);
        ClipboardSyncStorage.CipherBox broken = new ClipboardSyncStorage.CipherBox() {
            @Override
            public ClipboardSyncStorage.EncryptedPayload encrypt(byte[] plaintext) throws Exception {
                throw new IllegalStateException("keystore unavailable");
            }

            @Override
            public byte[] decrypt(byte[] iv, byte[] ciphertext) throws Exception {
                throw new IllegalStateException("keystore unavailable");
            }
        };
        ClipboardSyncStorage storage = new ClipboardSyncStorage(file, broken);
        ClipboardSyncStorage.Binding binding = ClipboardSyncStorage.Binding.create(
                "https://center.example.com", "dev-1", "tok-1", null);

        try {
            storage.saveForBinding(binding, true, "GROUP-SECRET");
            fail("expected IOException when cipher fails");
        } catch (IOException expected) {
            assertFalse(expected.getMessage().contains("GROUP-SECRET"));
        }
        assertFalse("must never fall back to writing plaintext file", file.exists());
    }

    @Test
    public void wrongKeyOrTamperedFileThrowsRedactedIoError() throws Exception {
        File file = new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME);
        ClipboardSyncStorage writer = new ClipboardSyncStorage(file, newAesGcmBox());
        ClipboardSyncStorage readerWrongKey = new ClipboardSyncStorage(file, newAesGcmBox());
        ClipboardSyncStorage.Binding binding = ClipboardSyncStorage.Binding.create(
                "https://center.example.com", "dev-1", "tok-1", null);

        writer.saveForBinding(binding, true, "GROUP-SECRET-999");

        try {
            readerWrongKey.readForBinding(binding);
            fail("expected IOException with wrong key");
        } catch (IOException expected) {
            assertFalse(expected.getMessage().contains("GROUP-SECRET-999"));
        }
    }

    @Test
    public void clearRemovesStoredState() throws Exception {
        File file = new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME);
        ClipboardSyncStorage storage = new ClipboardSyncStorage(file, newAesGcmBox());
        ClipboardSyncStorage.Binding binding = ClipboardSyncStorage.Binding.create(
                "https://center.example.com", "dev-1", "tok-1", null);

        storage.saveForBinding(binding, true, "GROUP-1");
        assertTrue(file.exists());

        storage.clear();
        assertFalse(file.exists());
        assertFalse(new File(file.getPath() + ".bak").exists());

        ClipboardSyncStorage.State after = storage.readForBinding(binding);
        assertFalse(after.enabled);
        assertFalse(after.isConfigured());
    }
}
