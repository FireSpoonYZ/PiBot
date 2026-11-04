// 统一「图形工作环境」抽象：Bot 屏幕的预览与人工接管不直接依赖 Shower/RDP/VNC。
// Android（Shower 虚拟屏）、Windows（Child Session + 会话内执行器）、Linux（Xvnc + X11 执行器）
// 只是不同的平台实现；UI 与跨设备协议只认这里的类型。
//
// 产品语义（所有平台一致）：
// - 每个 Bot 一块屏（一个员工一台电脑），Bot 的主私聊、群与 DM 上下文共用。
// - 关闭预览、中断 AI、重载 extension 都不销毁工作桌面。
// - 「接管」= 调用该 Bot 已有的 interrupt → 执行器取消在途动作、释放按下的键鼠 → 确认后接受人工输入。
//   没有「交还」：之后 Bot 与用户可以同时操作，冲突由用户自行处理；
//   Bot 下一次非截图动作前必须重新截图，从当前现场继续。
// - 独立桌面不等于安全沙箱。

/** 平台实现标识；新增平台只在此扩展，UI 按 capabilities 决定可用操作。 */
export type ScreenPlatform = 'android-shower' | 'windows-child-session' | 'linux-xvnc';

export type ScreenCapabilities = {
  /** 与用户主屏/主桌面隔离（不向主桌面注入输入）。 */
  isolatedDesktop: boolean;
  launchApp: boolean;
  resize: boolean;
  input: { touch: boolean; mouse: boolean; keyboard: boolean; text: boolean };
};

/** 平台能力表（由平台实现声明，UI 不做平台判断）。 */
export const SCREEN_CAPABILITIES: Record<ScreenPlatform, ScreenCapabilities> = {
  'android-shower': {
    isolatedDesktop: true, launchApp: true, resize: false,
    input: { touch: true, mouse: false, keyboard: false, text: false },
  },
  'windows-child-session': {
    isolatedDesktop: true, launchApp: true, resize: false,
    input: { touch: false, mouse: true, keyboard: true, text: true },
  },
  'linux-xvnc': {
    isolatedDesktop: true, launchApp: true, resize: true,
    input: { touch: false, mouse: true, keyboard: true, text: true },
  },
};

/** 屏幕本身（Host 侧描述）；归属只由 Host 根据可信上下文决定，客户端不能指定。 */
export type ScreenDescriptor = {
  botId: string;
  platform: ScreenPlatform;
  width: number;
  height: number;
  density?: number;
};

/**
 * 观看会话状态：
 * idle 未打开；connecting 正在连接；none 该 Bot 还没有屏幕；live 实时画面；
 * ended 屏幕已被释放或空闲回收；error 连接失败（会自动重试）；unavailable 服务不可用。
 */
export type ScreenPhase = 'idle' | 'connecting' | 'none' | 'live' | 'ended' | 'error' | 'unavailable';

export type ScreenViewState = {
  phase: ScreenPhase;
  live: boolean;
  /** 本观看会话已接管，可直接操作画面。 */
  userControl: boolean;
  width: number;
  height: number;
  platform: ScreenPlatform;
  message?: string;
};

/** 画面在页面中的位置（CSS 像素，相对视口）；null 表示暂时隐藏（动画中、被遮挡）。 */
export type ScreenViewport = { x: number; y: number; width: number; height: number; radius: number } | null;

/** 平台无关的人工输入；坐标一律为屏幕自身像素坐标（与 Agent 工具坐标一致）。 */
export type ScreenInput =
  | { t: 'touch'; action: 'down' | 'move' | 'up' | 'cancel'; pointers: { id: number; x: number; y: number }[]; ts: number }
  | { t: 'mouse'; action: 'move' | 'down' | 'up' | 'wheel'; button?: 0 | 1 | 2; x: number; y: number; dx?: number; dy?: number }
  | { t: 'key'; code: string; down: boolean; modifiers?: string[] }
  | { t: 'text'; value: string };

/** 一次观看：打开后由客户端负责把画面贴到 viewport 并转发接管后的输入。 */
export interface ScreenViewer {
  layout(viewport: ScreenViewport): Promise<ScreenViewState>;
  status(): Promise<ScreenViewState>;
  /** 只做执行器侧的停止与接管；对话 interrupt 由调用方先完成。 */
  takeover(): Promise<ScreenViewState>;
  close(): Promise<void>;
}

/** 某类 Host/平台组合的客户端实现。 */
export interface ScreenClient {
  readonly platform: ScreenPlatform;
  readonly capabilities: ScreenCapabilities;
  open(botId: string): Promise<ScreenViewer>;
}

// ---------------- 跨设备协议（远端 Host；本期只定接口，未实现） ----------------
// 走现有认证控制通道：控制面为下列 JSON 方法，画面帧走同一 live 流的 screenFrame 事件。
// 客户端不直连 VNC/RDP 端口，也不接触 Binder。

export type RemoteScreenMethods = {
  'screens.status': { params: { botId: string }; result: { screen: ScreenDescriptor | null } };
  'screens.attach': {
    params: { botId: string; codecs: string[]; maxWidth?: number; maxHeight?: number };
    result: { viewerId: string; codec: string; screen: ScreenDescriptor };
  };
  'screens.detach': { params: { viewerId: string }; result: Record<string, never> };
  /** Host 侧先执行该 Bot 的 interrupt 与执行器停止，确认后才返回。 */
  'screens.takeover': { params: { viewerId: string }; result: { userControl: true } };
  'screens.input': { params: { viewerId: string; events: ScreenInput[] }; result: Record<string, never> };
};

export type RemoteScreenFrame = {
  type: 'screenFrame';
  viewerId: string;
  codec: string;
  keyframe: boolean;
  /** 编码后的帧（base64）。 */
  data: string;
  width: number;
  height: number;
};
