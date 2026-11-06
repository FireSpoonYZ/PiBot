package com.example.launcherprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 仅接收本应用 PackageInstaller 会话的显式系统回调。 */
public final class ClientUpdateResultReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        ClientUpdateInstaller.onResult(context, intent);
    }
}
