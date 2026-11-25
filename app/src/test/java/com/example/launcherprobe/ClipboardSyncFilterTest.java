package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.PersistableBundle;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * Verifies plain-text extraction, including sensitive text, own-clip and Shower
 * "pibot" label rejection, URI/Intent non-dereference rejection, and action parameter validation.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClipboardSyncFilterTest {

    @Test
    public void acceptsStrictPlainTextClip() {
        ClipData clip = ClipData.newPlainText("user-copy", "hello clipboard sync");
        ClipboardSyncController.ClipReadResult result = ClipboardSyncController.extractSendableText(clip);
        assertTrue(result.ok);
        assertEquals("hello clipboard sync", result.text);
    }

    @Test
    public void incomingClipMarksOwnAndSensitiveAndIsRejectedOnRead() {
        ClipData incoming = ClipboardSyncController.buildIncomingClip("remote-secret-text");
        ClipDescription description = incoming.getDescription();
        assertNotNull(description);
        assertEquals(ClipboardSyncController.OWN_CLIP_LABEL, description.getLabel().toString());
        PersistableBundle extras = description.getExtras();
        assertNotNull(extras);
        assertTrue(extras.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false));
        assertTrue(extras.getBoolean(ClipboardSyncController.EXTRA_OWN_SYNC, false));

        ClipboardSyncController.ClipReadResult readBack = ClipboardSyncController.extractSendableText(incoming);
        assertFalse(readBack.ok);
        assertNull(readBack.text);
        assertEquals("CLIPBOARD_REJECTED", readBack.errorCode);
    }

    @Test
    public void rejectsShowerCreatedPibotLabel() {
        ClipData showerClip = ClipData.newPlainText("pibot", "injected-by-shower");
        ClipboardSyncController.ClipReadResult result = ClipboardSyncController.extractSendableText(showerClip);
        assertFalse(result.ok);
        assertNull(result.text);
        assertEquals("CLIPBOARD_REJECTED", result.errorCode);
    }

    @Test
    public void rejectsUriIntentAndNonTextMimeWithoutDereference() {
        Uri contentUri = Uri.parse("content://com.example.secret.provider/private/1");
        ClipData rawUriClip = ClipData.newRawUri("uri", contentUri);
        assertFalse(ClipboardSyncController.extractSendableText(rawUriClip).ok);

        // Even if MIME claims text/plain, an item carrying a URI must be rejected without dereference.
        ClipData spoofedUriClip = new ClipData(
                new ClipDescription("spoof", new String[]{ClipDescription.MIMETYPE_TEXT_PLAIN}),
                new ClipData.Item("visible", null, contentUri));
        assertFalse(ClipboardSyncController.extractSendableText(spoofedUriClip).ok);

        Intent intent = new Intent("com.example.ACTION_SECRET");
        ClipData intentClip = ClipData.newIntent("intent", intent);
        assertFalse(ClipboardSyncController.extractSendableText(intentClip).ok);

        // Even if MIME claims text/plain, an item carrying an Intent must be rejected without dereference.
        ClipData spoofedIntentClip = new ClipData(
                new ClipDescription("spoof", new String[]{ClipDescription.MIMETYPE_TEXT_PLAIN}),
                new ClipData.Item("visible", intent, null));
        assertFalse(ClipboardSyncController.extractSendableText(spoofedIntentClip).ok);

        // Plain text paired with a file/image format remains ineligible.
        ClipData imageMime = new ClipData(
                new ClipDescription("img", new String[]{ClipDescription.MIMETYPE_TEXT_PLAIN, "image/png"}),
                new ClipData.Item("ignored"));
        assertFalse(ClipboardSyncController.extractSendableText(imageMime).ok);
    }

    @Test
    public void acceptsPlainRepresentationButNeverFallsBackToHtml() {
        ClipData htmlClip = ClipData.newHtmlText("browser", "plain only", "<b>different text</b>");
        ClipboardSyncController.ClipReadResult result = ClipboardSyncController.extractSendableText(htmlClip);
        assertTrue(result.ok);
        assertEquals("plain only", result.text);

        ClipData bothTypes = new ClipData("browser",
                new String[]{ClipDescription.MIMETYPE_TEXT_PLAIN, ClipDescription.MIMETYPE_TEXT_HTML},
                new ClipData.Item("existing plain text", "<b>markup</b>"));
        assertEquals("existing plain text", ClipboardSyncController.extractSendableText(bothTypes).text);
        assertFalse(ClipboardSyncController.extractSendableText(
                ClipData.newHtmlText("html", "", "<b>markup</b>")).ok);
    }

    @Test
    public void shareAndSelectionAcceptOnlyEligiblePlainText() {
        Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "shared text")
                .putExtra(Intent.EXTRA_HTML_TEXT, "<b>not sent</b>");
        assertEquals("shared text", ClipboardSyncShareActivity.readSharedText(share).text);

        Intent selection = new Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain")
                .putExtra(Intent.EXTRA_PROCESS_TEXT, "selected text");
        assertEquals("selected text", ClipboardSyncShareActivity.readSharedText(selection).text);

        share.setClipData(ClipboardSyncController.buildIncomingClip("remote text"));
        assertFalse(ClipboardSyncShareActivity.readSharedText(share).ok);
        share.setClipData(null);
        share.putExtra(Intent.EXTRA_STREAM, Uri.parse("content://com.example.secret/private"));
        assertFalse(ClipboardSyncShareActivity.readSharedText(share).ok);

        selection.putExtra(Intent.EXTRA_PROCESS_TEXT, "embedded pibot-clipboard-v1:secret");
        assertEquals("CLIPBOARD_REJECTED", ClipboardSyncShareActivity.readSharedText(selection).errorCode);
        selection.putExtra(Intent.EXTRA_PROCESS_TEXT, "broken \ud800 surrogate");
        assertFalse(ClipboardSyncShareActivity.readSharedText(selection).ok);
    }

    @Test
    public void rejectsMultiItemAndEmptyClips() {
        ClipData multi = ClipData.newPlainText("multi", "first");
        multi.addItem(new ClipData.Item("second"));
        assertFalse(ClipboardSyncController.extractSendableText(multi).ok);

        ClipData empty = ClipData.newPlainText("empty", "");
        ClipboardSyncController.ClipReadResult emptyRes = ClipboardSyncController.extractSendableText(empty);
        assertFalse(emptyRes.ok);
        assertEquals("CLIPBOARD_EMPTY", emptyRes.errorCode);

        assertFalse(ClipboardSyncController.extractSendableText(null).ok);
    }

    @Test
    public void readsAndFiltersViaSystemClipboardManager() {
        ClipboardManager manager = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager.class);
        assertNotNull(manager);

        ClipData sensitive = ClipData.newPlainText("test-code", "123456");
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
        sensitive.getDescription().setExtras(extras);
        manager.setPrimaryClip(sensitive);
        ClipboardSyncController.ClipReadResult ok = ClipboardSyncController.readSendableClip(manager);
        assertTrue(ok.ok);
        assertEquals("123456", ok.text);

        manager.setPrimaryClip(ClipData.newPlainText("pibot", "shower-text"));
        ClipboardSyncController.ClipReadResult rejected = ClipboardSyncController.readSendableClip(manager);
        assertFalse(rejected.ok);
        assertEquals("CLIPBOARD_REJECTED", rejected.errorCode);
    }

    @Test
    public void validatesPluginParamsStrictlyAndNeverAcceptsWebPlaintext() throws Exception {
        assertEquals("status", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "status")));
        assertEquals("setEnabled", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "setEnabled").put("enabled", true)));
        assertEquals("newGroup", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "newGroup")));
        assertEquals("joinGroup", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "joinGroup").put("code", "ABCD-1234")));
        assertEquals("showCode", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "showCode")));
        assertEquals("sendNow", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "sendNow")));
        assertEquals("authorizeBackground", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "authorizeBackground")));
        assertEquals("revokeBackground", BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "revokeBackground")));

        // Reject plaintext injection via sendNow or extra keys on any action.
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "sendNow").put("text", "forged")));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "authorizeBackground").put("extra", true)));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "revokeBackground").put("force", true)));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "status").put("extra", true)));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "setEnabled").put("enabled", "true")));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "joinGroup").put("code", "   ")));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(
                new JSONObject().put("action", "unknown")));
        assertNull(BotHostTauriPlugin.validateClipboardSyncParams(null));

        assertTrue(BotHostUiProtocol.isOperation("clipboardSync"));
        assertTrue(BotHostUiProtocol.isOperation("clipboardSyncSend"));
    }

    @Test
    public void enforcesStrictUtf8ByteLimitMatchingCore() {
        String exactAscii = "a".repeat(ClipboardSyncController.MAX_TEXT_BYTES);
        assertTrue(ClipboardSyncController.extractSendableText(
                ClipData.newPlainText("ok", exactAscii)).ok);

        String overAscii = "a".repeat(ClipboardSyncController.MAX_TEXT_BYTES + 1);
        ClipboardSyncController.ClipReadResult overAsciiRes = ClipboardSyncController.extractSendableText(
                ClipData.newPlainText("big", overAscii));
        assertFalse(overAsciiRes.ok);
        assertEquals("CLIPBOARD_TOO_LARGE", overAsciiRes.errorCode);

        // Multi-byte UTF-8: 3-byte CJK characters exceeding 65,536 bytes despite < 65,536 chars.
        String overCjk = "中".repeat((ClipboardSyncController.MAX_TEXT_BYTES / 3) + 1);
        ClipboardSyncController.ClipReadResult overCjkRes = ClipboardSyncController.extractSendableText(
                ClipData.newPlainText("cjk", overCjk));
        assertFalse(overCjkRes.ok);
        assertEquals("CLIPBOARD_TOO_LARGE", overCjkRes.errorCode);
    }
}
