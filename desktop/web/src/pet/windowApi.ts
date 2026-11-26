import { invoke } from '@tauri-apps/api/core';
import type {
  DesktopPetKdeRuleAction,
  DesktopPetKdeRuleStatus,
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

export function petKdeRule(
  action: DesktopPetKdeRuleAction,
): Promise<DesktopPetKdeRuleStatus> {
  return invoke<DesktopPetKdeRuleStatus>('desktop_pet_kde_rule', { action });
}
