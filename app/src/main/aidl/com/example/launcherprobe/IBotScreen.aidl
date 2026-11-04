package com.example.launcherprobe;

import android.view.MotionEvent;
import android.view.Surface;

/**
 * 新 Host Bot 屏幕：:tauri_ui 进程观看与接管本机 Host 中某个 Bot 已有的 Shower 虚拟屏。
 * 只服务本应用 UID；viewer 是 UI 侧的 Binder 令牌，进程死亡即自动解绑。返回值为 JSON 文本。
 */
interface IBotScreen {
    /** {exists, platform, width?, height?, dpi?}；不创建屏幕，也不延长空闲时间。 */
    String status(String botId) = 1;
    /** 把 surface 接为该 Bot 屏幕的预览；同一 viewer 先解绑旧画面。返回 {width, height}。 */
    String attach(String botId, in Surface surface, IBinder viewer) = 2;
    void detach(IBinder viewer) = 3;
    /** 观看中保活屏幕；画面已结束返回 false 并自动解绑。 */
    boolean keepAlive(IBinder viewer) = 4;
    /** 中断该 Bot 在途屏幕动作后接受用户输入；返回 {userControl:true}。 */
    String takeover(IBinder viewer) = 5;
    /** 坐标已映射到虚拟屏像素；oneway 保持同一 viewer 的事件顺序且不阻塞 UI。 */
    oneway void touch(IBinder viewer, in MotionEvent event) = 6;
}
