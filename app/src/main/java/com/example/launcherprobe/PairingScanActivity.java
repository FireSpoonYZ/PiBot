package com.example.launcherprobe;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;

import com.google.zxing.client.android.R;
import com.journeyapps.barcodescanner.CaptureManager;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;

/**
 * 配对码扫描界面：与 zxing-android-embedded 的 CaptureActivity 同构，只多关一件事——
 * 相机权限被拒时不弹库自带的“Android 相机出现问题，您可能需要重启设备”对话框。
 * 那句话会把用户引去重启手机，而真正要做的是在系统设置里允许相机或改用粘贴；
 * 关掉后库直接带着 MISSING_CAMERA_PERMISSION 结束，由 BotHostTauriPlugin 回 CAMERA_DENIED。
 */
public class PairingScanActivity extends Activity {
    private CaptureManager capture;
    private DecoratedBarcodeView scannerView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.zxing_capture);
        scannerView = findViewById(R.id.zxing_barcode_scanner);
        capture = new CaptureManager(this, scannerView);
        capture.setShowMissingCameraPermissionDialog(false);
        capture.initializeFromIntent(getIntent(), savedInstanceState);
        capture.decode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        capture.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        capture.onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        capture.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        capture.onSaveInstanceState(outState);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        capture.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        return scannerView.onKeyDown(keyCode, event) || super.onKeyDown(keyCode, event);
    }
}
