package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Toast;

import java.util.function.BooleanSupplier;

/** Explicit system share target. Never reads a URI or sends on an incoming Intent alone. */
public final class ClipboardSyncShareActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ClipboardSyncController.ClipReadResult result = readSharedText(getIntent());
        if (!result.ok) {
            finishWith(R.string.clipboard_share_invalid);
            return;
        }
        BooleanSupplier ownerOpen = BotClientService.ownerOpen();
        if (!ownerOpen.getAsBoolean()) {
            finishWith(R.string.clipboard_share_not_ready);
            return;
        }

        String text = result.text;
        int end = text.offsetByCodePoints(0, Math.min(160, text.codePointCount(0, text.length())));
        String preview = end == text.length() ? text : text.substring(0, end) + "…";
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.clipboard_share_title)
                .setMessage(getString(R.string.clipboard_share_confirm, preview))
                .setNegativeButton(android.R.string.cancel, (d, which) -> finish())
                .setPositiveButton(R.string.clipboard_share_send, (d, which) -> {
                    if (!ownerOpen.getAsBoolean()) {
                        finishWith(R.string.clipboard_share_not_ready);
                        return;
                    }
                    ClipboardSyncController.get(this).sendNow(text).whenComplete((reply, failure) ->
                            runOnUiThread(() -> {
                                if (!isFinishing() && !isDestroyed()) {
                                    finishWith(failure == null
                                            ? R.string.clipboard_share_queued
                                            : R.string.clipboard_share_not_ready);
                                }
                            }));
                })
                .setOnCancelListener(d -> finish())
                .create();
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
    }

    static ClipboardSyncController.ClipReadResult readSharedText(Intent intent) {
        try {
            if (intent != null && ClipDescription.MIMETYPE_TEXT_PLAIN.equals(intent.getType())
                    && intent.getData() == null && !intent.hasExtra(Intent.EXTRA_STREAM)) {
                String key = Intent.ACTION_SEND.equals(intent.getAction()) ? Intent.EXTRA_TEXT
                        : Intent.ACTION_PROCESS_TEXT.equals(intent.getAction()) ? Intent.EXTRA_PROCESS_TEXT : null;
                if (key != null) {
                    ClipData clip = intent.getClipData();
                    if (clip != null) {
                        ClipboardSyncController.ClipReadResult checked =
                                ClipboardSyncController.extractSendableText(clip);
                        if (!checked.ok) return checked;
                    }
                    return ClipboardSyncController.validatePlainText(intent.getCharSequenceExtra(key));
                }
            }
        } catch (RuntimeException ignored) {
            // A caller can supply malformed extras. Never display or log them.
        }
        return ClipboardSyncController.ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "仅支持纯文本分享");
    }

    private void finishWith(int message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        finish();
    }
}
