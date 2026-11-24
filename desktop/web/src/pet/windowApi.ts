import { invoke } from '@tauri-apps/api/core';
import type {
  DesktopPetWindowAction,
  DesktopPetWindowState,
  PetWindowLayoutRequest,
} from './protocol';

export function petWindow(
  action: DesktopPetWindowAction,
  expanded?: boolean,
  layout?: PetWindowLayoutRequest,
): Promise<DesktopPetWindowState> {
  return invoke<DesktopPetWindowState>('desktop_pet', { action, expanded, layout });
}
