// Scopes 只读浏览所需的最小 API 面（scope-ui lane）。
// 远端面板传入完整 DesktopViewApi；本机只读适配器（mobile lane）只需实现该子集，
// 真实读取走 BotHost.call，不需要远端连接或伪造的写方法。
import type { DesktopIdentity, DesktopViewApi } from './types';
import type { ScopeInfo } from '../../../host-core/index.js';

/**
 * 只读能力：list/history/message 读取、live 观察与错误上报。
 * 不含 pending/mutateIntent/草稿等 mutation 方法，类型层面排除写路径。
 */
export type ScopeReadApi = Pick<
  DesktopViewApi,
  'identity' | 'identityForTarget' | 'transportConnected' | 'call' | 'observe' | 'reportError' | 'snapshot'
>;

/** 写操作（成员编辑/会话创建/房间发送）所需的完整视图 API。 */
export type ScopeWriteApi = DesktopViewApi;

/**
 * 群聊写端解析器：宿主按 scope 路由发送/成员写通道（members 只可达 authority，
 * send 走成员所在可用 Host）。返回真实完整 DesktopViewApi；尚未连上写端返回 null，
 * 详情按“待连接”降级而不是只读。内容相同/代际与在线态不变时返回值必须稳定。
 */
export type RoomApiResolver = (scope: ScopeInfo, purpose: 'send' | 'members') => DesktopViewApi | null;

const WRITE_METHODS = ['pending', 'mutateIntent', 'saveDraft', 'clearDraft', 'draftKey', 'pickFile'] as const;

/** 真实能力检查：对象同时具备全部写方法才是可写 API；只读适配器自然返回 false。 */
export function isScopeWritableApi(api: ScopeReadApi): api is DesktopViewApi {
  const raw = api as Record<string, unknown>;
  return WRITE_METHODS.every((m) => typeof raw[m] === 'function');
}

export type { DesktopIdentity };
