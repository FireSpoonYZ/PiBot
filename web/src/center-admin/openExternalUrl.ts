interface ExternalUrlBridgeWindow extends Window {
  AndroidBridge?: {
    openExternalUrl?: (u: string) => void;
  };
  __TAURI__?: {
    opener?: {
      openUrl?: (u: string) => Promise<void>;
    };
    shell?: {
      open?: (u: string) => Promise<void>;
    };
  };
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Open an external URL in the system default browser across Android WebView,
 * Desktop/Android Tauri v2, and standard Web environments.
 */
export async function openExternalUrl(
  url: string,
  handler?: (url: string) => void | Promise<unknown>,
): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;

  if (handler) {
    await handler(trimmed);
    return;
  }

  if (typeof window === 'undefined') return;
  const win = window as ExternalUrlBridgeWindow;

  if (typeof win.AndroidBridge?.openExternalUrl === 'function') {
    win.AndroidBridge.openExternalUrl(trimmed);
    return;
  }

  if (typeof win.__TAURI__?.opener?.openUrl === 'function') {
    try {
      await win.__TAURI__.opener.openUrl(trimmed);
      return;
    } catch {
      // Fall through to remaining Tauri / Web openers
    }
  }

  if (typeof win.__TAURI__?.shell?.open === 'function') {
    try {
      await win.__TAURI__.shell.open(trimmed);
      return;
    } catch {
      // Fall through to __TAURI_INTERNALS__.invoke
    }
  }

  const internals = win.__TAURI_INTERNALS__;
  if (typeof internals?.invoke === 'function') {
    const tauriCommands: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['plugin:opener|open_url', { url: trimmed }],
      ['plugin:shell|open', { path: trimmed }],
      ['desktop_open_center', { url: trimmed }],
      ['mobile_host_request', { method: 'openCenter', params: { url: trimmed } }],
    ];
    for (const [cmd, args] of tauriCommands) {
      try {
        await internals.invoke(cmd, args);
        return;
      } catch {
        // Try next Tauri command
      }
    }
  }

  const opened = window.open(trimmed, '_blank', 'noopener,noreferrer');
  if (!opened && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = trimmed;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }
}
