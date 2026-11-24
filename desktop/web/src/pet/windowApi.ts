import { invoke } from '@tauri-apps/api/core';
import type { DesktopPetWindowAction, DesktopPetWindowState } from './protocol';

export function petWindow(action: DesktopPetWindowAction, expanded?: boolean): Promise<DesktopPetWindowState> {
  return invoke<DesktopPetWindowState>('desktop_pet', { action, expanded });
}
