import { emitTo, listen } from '@tauri-apps/api/event';
import type { DesktopPanelApi } from '../types';
import { createDesktopPetController } from './controller';
import { PET_EVENTS, type DesktopPetAction, type DesktopPetWindowState } from './protocol';
import { petWindow } from './windowApi';
import { completePetAction } from './drafts';

/** The main document owns the existing client; the pet never opens a second broker connection. */
export async function startDesktopPetHost(api: DesktopPanelApi): Promise<() => void> {
  const controller = createDesktopPetController(api, (snapshot) => {
    void emitTo('pet', PET_EVENTS.state, snapshot).catch(() => {});
  });
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    controller.start();
  };
  const stop = () => {
    started = false;
    controller.stop();
  };
  const unlistenAction = await listen<DesktopPetAction>(PET_EVENTS.action, ({ payload }) => {
    start();
    void controller.handleAction(payload).then(
      (result) => emitTo('pet', PET_EVENTS.result, completePetAction(payload, result, localStorage)),
      (error: unknown) => emitTo('pet', PET_EVENTS.result, {
        id: payload.id, ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    ).catch(() => {});
  });
  const unlistenWindow = await listen<DesktopPetWindowState>(PET_EVENTS.window, ({ payload }) => {
    if (payload.visible) start();
    else stop();
  });
  // Reloading the main document must reconnect an already-open pet.
  if ((await petWindow('status')).visible) start();
  return () => {
    unlistenAction();
    unlistenWindow();
    stop();
  };
}
