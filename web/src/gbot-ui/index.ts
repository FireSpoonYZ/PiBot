// gbot-ui lane：lenML/gbot-ui（MIT，licenses/gbot-ui-MIT.txt）行组件/菜单/群头像
// 与 scope 会话列表 hook 的共享导出。import 本模块即自动引入 gbot-ui.css。
// 不引入上游 demo/store/transport，不新增包。
import './gbot-ui.css';

export { ConversationRow } from './ConversationRow';
export type { ConversationRowProps } from './ConversationRow';
export { ConversationContextMenu } from './ConversationContextMenu';
export type {
  ConversationContextMenuProps,
  ConversationMenuItem,
} from './ConversationContextMenu';
export { useConversationRowInteractions } from './useConversationRowInteractions';
export type {
  ConversationMenuPosition,
  UseConversationRowInteractionsInput,
} from './useConversationRowInteractions';
export { ConversationGroupAvatar } from './ConversationGroupAvatar';
export type { ConversationGroupAvatarProps } from './ConversationGroupAvatar';
export { useScopeConversations } from './useScopeConversations';
export type {
  ScopeConversation,
  ScopeConversationSource,
  UseScopeConversationsResult,
} from './useScopeConversations';
export {
  ConversationChatHeader,
  ConversationMessage,
  ConversationTimeDivider,
  conversationMemberName,
  conversationTitle,
} from './ConversationChat';
export type {
  ConversationBot,
  ConversationChatHeaderProps,
  ConversationMessageProps,
  ConversationTimeDividerProps,
} from './ConversationChat';
