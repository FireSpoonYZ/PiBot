import type { DesktopPanelApi } from './types';

/** 保留组件的当前身份检查，同时把每次操作绑定到选中设备而不是连接全局目标。 */
export function targetApi(api: DesktopPanelApi, deviceId: string, targetOnline = true): DesktopPanelApi {
  const identity = api.identityForTarget(deviceId);
  return new Proxy(api, {
    get(target, property) {
      if (property === 'transportConnected') return target.transportConnected && targetOnline;
      if (property === 'identity') {
        const current = target.identity;
        return current && current.profileId === identity.profileId && current.kind === identity.kind &&
          current.generation === identity.generation ? identity : null;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
