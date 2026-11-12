import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { BotAvatar } from '../../center-contract/index.js';
import type { BotLearningLiveState, BotLearningOutcomeSummary } from '../../host-core/index.js';
import { botActivityText, isBotLlmRunningPhase, isBotPreLlmPhase, type BotActivity } from './botActivity';
import {
  GROK_EXPRESSIONS,
  GROK_HEAD_CENTER,
  GROK_SHAPES,
  GROK_STAR_GOLD,
  GROK_STAR_PATH,
} from './grokBotData';
import {
  GROK_POKE_TYPES,
  createGrokAppearance,
  createGrokMascotController,
  normalizeGrokBodyShape,
  resolveGrokMascotState,
  type GrokMascotState,
} from './grokMascotEngine';

export type GrokAvatarPreset = BotAvatar;

export const GROK_COLOR_PALETTE: ReadonlyArray<{ id: string; hex: string; labelZh: string; labelEn: string }> = [
  { id: 'black', hex: '#080808', labelZh: '曜石黑', labelEn: 'Obsidian' },
  { id: 'brown', hex: '#7E5738', labelZh: '摩卡棕', labelEn: 'Mocha' },
  { id: 'red', hex: '#EA403C', labelZh: '珊瑚红', labelEn: 'Coral Red' },
  { id: 'orange', hex: '#E86B26', labelZh: '活力橙', labelEn: 'Tangerine' },
  { id: 'amber', hex: '#F09E2B', labelZh: '暖阳黄', labelEn: 'Amber' },
  { id: 'green', hex: '#4EBD64', labelZh: '翠竹绿', labelEn: 'Emerald' },
  { id: 'teal', hex: '#48AB94', labelZh: '松石青', labelEn: 'Teal' },
  { id: 'blue', hex: '#2B70F6', labelZh: '经典蓝', labelEn: 'Classic Blue' },
  { id: 'purple', hex: '#795BF2', labelZh: '星云紫', labelEn: 'Violet' },
  { id: 'pink', hex: '#DF4191', labelZh: '多巴胺粉', labelEn: 'Magenta' },
];

export const GROK_SHAPE_ORDER: ReadonlyArray<{ shape: string; rotation: number; labelZh: string; labelEn: string }> = [
  // Row 1 (4 shapes in 15848.jpg)
  { shape: 'blob', rotation: 0, labelZh: '经典圆', labelEn: 'Circle' },
  { shape: 'cloud', rotation: -6, labelZh: '云朵', labelEn: 'Cloud' },
  { shape: 'squircle', rotation: -18, labelZh: '方糖', labelEn: 'Squircle' },
  { shape: 'gem', rotation: 0, labelZh: '四芒星', labelEn: 'Star' },
  // Row 2 (5 shapes in 15848.jpg)
  { shape: 'bean', rotation: -12, labelZh: '四叶草', labelEn: 'Clover' },
  { shape: 'arch', rotation: -10, labelZh: '爱心', labelEn: 'Heart' },
  { shape: 'crystal', rotation: 0, labelZh: '花朵', labelEn: 'Blossom' },
  { shape: 'teardrop', rotation: 10, labelZh: '水滴', labelEn: 'Droplet' },
  { shape: 'pebble', rotation: -14, labelZh: '胶囊豆', labelEn: 'Pebble' },
  // Row 3 (5 shapes in 15848.jpg)
  { shape: 'wedge', rotation: 14, labelZh: '三角', labelEn: 'Wedge' },
  { shape: 'shield', rotation: -12, labelZh: '五边形', labelEn: 'Shield' },
  { shape: 'dome', rotation: 0, labelZh: '星芒', labelEn: 'Burst' },
  { shape: 'hex', rotation: 10, labelZh: '六边形', labelEn: 'Hexagon' },
  { shape: 'leaf', rotation: -8, labelZh: '果实', labelEn: 'Fruit' },
  // Extra 4 shapes from GROK_SHAPES
  { shape: 'egg', rotation: -8, labelZh: '卵石', labelEn: 'Egg' },
  { shape: 'tablet', rotation: 12, labelZh: '方片', labelEn: 'Tablet' },
  { shape: 'capsule', rotation: -15, labelZh: '长胶囊', labelEn: 'Capsule' },
  { shape: 'cylinder', rotation: 8, labelZh: '圆柱', labelEn: 'Cylinder' },
];

export const GROK_EXPRESSION_LIST: ReadonlyArray<{ index: number; labelZh: string; labelEn: string }> = [
  { index: 0, labelZh: '专注仰视', labelEn: 'Focused' },
  { index: 1, labelZh: '灵动平视', labelEn: 'Bright' },
  { index: 2, labelZh: '好奇大眼', labelEn: 'Curious' },
  { index: 3, labelZh: '俏皮眨眼', labelEn: 'Wink' },
  { index: 4, labelZh: '向左张望', labelEn: 'Glance' },
  { index: 5, labelZh: '圆润微笑', labelEn: 'Happy' },
];

export const JARVIS_AVATAR_PRESET: GrokAvatarPreset = {
  id: 'jarvis-blue',
  shape: 'blob',
  color: '#2B70F6',
  rotation: 0,
  expressionIndex: 0,
  labelZh: '经典蓝',
  labelEn: 'Classic Blue',
};

export const GROK_AVATAR_PRESETS: ReadonlyArray<GrokAvatarPreset> = [
  { id: 'pink-wedge', shape: 'wedge', color: '#DF4191', rotation: 14, expressionIndex: 0, labelZh: '玫红三角', labelEn: 'Pink Wedge' },
  { id: 'slate-cloud', shape: 'cloud', color: '#48AB94', rotation: -6, expressionIndex: 1, labelZh: '松石云朵', labelEn: 'Teal Cloud' },
  { id: 'pink-pebble', shape: 'pebble', color: '#DF4191', rotation: -14, expressionIndex: 1, labelZh: '粉红胶囊', labelEn: 'Pink Pebble' },
  { id: 'coral-wedge', shape: 'wedge', color: '#EA403C', rotation: 32, expressionIndex: 0, labelZh: '珊瑚三角', labelEn: 'Coral Wedge' },
  { id: 'coral-pebble', shape: 'pebble', color: '#EA403C', rotation: -14, expressionIndex: 1, labelZh: '珊瑚胶囊', labelEn: 'Coral Pebble' },
  { id: 'mint-gem', shape: 'gem', color: '#48AB94', rotation: 0, expressionIndex: 1, labelZh: '松石四芒星', labelEn: 'Teal Star' },
  { id: 'violet-bean', shape: 'bean', color: '#795BF2', rotation: -12, expressionIndex: 3, labelZh: '星云四叶草', labelEn: 'Violet Clover' },
  { id: 'solar-teardrop', shape: 'teardrop', color: '#F09E2B', rotation: 12, expressionIndex: 2, labelZh: '暖阳水滴', labelEn: 'Amber Drop' },
  { id: 'sky-hex', shape: 'hex', color: '#2B70F6', rotation: 10, expressionIndex: 4, labelZh: '天蓝六边', labelEn: 'Blue Hex' },
  { id: 'emerald-leaf', shape: 'leaf', color: '#4EBD64', rotation: -10, expressionIndex: 5, labelZh: '翠绿果实', labelEn: 'Green Fruit' },
];

const AVATAR_CONFIG_STORE_KEY = 'bot-hub-avatar-config-v2';
const OFFLINE_COLOR = '#6F7072';

// 旧灰色配置只调整显示颜色，保留形状及中心保存的数据。
function onlineAvatarPreset(preset: GrokAvatarPreset): GrokAvatarPreset {
  return preset.color.toUpperCase() === OFFLINE_COLOR
    ? { ...preset, color: '#48AB94', labelZh: '松石青', labelEn: 'Teal' }
    : preset;
}

export function getSavedAvatarConfigMap(): Record<string, GrokAvatarPreset> {
  try {
    const raw = window.localStorage.getItem(AVATAR_CONFIG_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, GrokAvatarPreset>) : {};
  } catch {
    return {};
  }
}

export function saveBotAvatarConfig(botKey: string, config: GrokAvatarPreset): void {
  try {
    const map = getSavedAvatarConfigMap();
    map[botKey] = config;
    window.localStorage.setItem(AVATAR_CONFIG_STORE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors
  }
}

export function resetBotAvatarConfig(botKey: string): void {
  try {
    const map = getSavedAvatarConfigMap();
    delete map[botKey];
    window.localStorage.setItem(AVATAR_CONFIG_STORE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors
  }
}

export function saveBotAvatarPreset(botKey: string, presetOrId: string | GrokAvatarPreset): void {
  if (typeof presetOrId === 'object') {
    saveBotAvatarConfig(botKey, presetOrId);
    return;
  }
  const found =
    presetOrId === JARVIS_AVATAR_PRESET.id
      ? JARVIS_AVATAR_PRESET
      : GROK_AVATAR_PRESETS.find(p => p.id === presetOrId);
  if (found) {
    saveBotAvatarConfig(botKey, found);
  }
}

export function getDefaultBotAvatarPreset(botKey: string, _roleName?: string, isPrimary?: boolean): GrokAvatarPreset {
  if (isPrimary) return JARVIS_AVATAR_PRESET;
  const seed = botKey;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % GROK_AVATAR_PRESETS.length;
  return GROK_AVATAR_PRESETS[index];
}

export function resolveBotAvatarPreset(botKey: string, roleName?: string, isPrimary?: boolean): GrokAvatarPreset {
  const saved = getSavedAvatarConfigMap()[botKey];
  if (saved && saved.shape && saved.color) {
    return onlineAvatarPreset(saved);
  }
  return getDefaultBotAvatarPreset(botKey, roleName, isPrimary);
}

export interface GrokBotAvatarProps {
  preset?: GrokAvatarPreset;
  botKey?: string;
  roleName?: string;
  isPrimary?: boolean;
  starBadge?: boolean;
  platformBadge?: string | ReactNode;
  busy?: boolean;
  reflecting?: boolean;
  offline?: boolean;
  size?: number;
  className?: string;
}

type AvatarPlatformKind = 'android' | 'windows' | 'linux' | 'macos' | 'globe';

function normalizeAvatarPlatform(platform?: string): AvatarPlatformKind | null {
  if (!platform || !platform.trim()) return null;
  const p = platform.trim().toLowerCase();
  if (p.includes('android')) return 'android';
  if (p.includes('win')) return 'windows';
  if (p.includes('darwin') || p.includes('mac') || p.includes('ios') || p.includes('apple')) return 'macos';
  if (p.includes('linux') || p.includes('ubuntu') || p.includes('debian') || p.includes('arch')) return 'linux';
  return 'globe';
}

function AvatarPlatformGlyph({ kind }: { kind: AvatarPlatformKind }) {
  if (kind === 'android') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.523 15.341a1.003 1.003 0 0 1-1.002-1.002c0-.553.45-1.002 1.002-1.002.553 0 1.002.45 1.002 1.002 0 .553-.449 1.002-1.002 1.002m-11.046 0a1.003 1.003 0 0 1-1.002-1.002c0-.553.45-1.002 1.002-1.002.553 0 1.002.45 1.002 1.002 0 .553-.449 1.002-1.002 1.002m11.405-6.02 1.997-3.46a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152L17.137 8.95c-1.547-.704-3.28-1.097-5.137-1.097-1.857 0-3.59.393-5.137 1.097L4.841 5.446a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.688 11.186.343 14.658 0 18.761h24c-.343-4.103-2.688-7.575-6.118-9.44" />
      </svg>
    );
  }
  if (kind === 'windows') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
      </svg>
    );
  }
  if (kind === 'linux') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C9.24 2 7 4.24 7 7v4.27c-1.21 1.48-2 3.32-2 5.23 0 2.76 2.24 5.5 7 5.5s7-2.74 7-5.5c0-1.91-.79-3.75-2-5.23V7c0-2.76-2.24-5-5-5zm-2 4.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zM12 10c1.38 0 2.5.67 2.5 1.5S13.38 13 12 13s-2.5-.67-2.5-1.5S10.62 10 12 10zm0 4.5c2.21 0 4 1.34 4 3s-1.79 3-4 3-4-1.34-4-3 1.79-3 4-3z" />
      </svg>
    );
  }
  if (kind === 'macos') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.96 6.33c.67-.81 1.12-1.94 1-3.08-.96.04-2.13.64-2.82 1.45-.61.7-.115 1.85-.99 2.97 1.08.08 2.14-.53 2.81-1.34" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8M12 3a14.5 14.5 0 0 0 0 18M12 3a14.5 14.5 0 0 1 0 18" />
    </svg>
  );
}

export function GrokBotAvatar({
  preset,
  botKey,
  roleName,
  isPrimary = false,
  starBadge = false,
  platformBadge,
  busy = false,
  reflecting = false,
  offline = false,
  size = 52,
  className = '',
}: GrokBotAvatarProps) {
  const clipId = useId().replace(/:/g, '_');
  const resolved = preset ? onlineAvatarPreset(preset) : resolveBotAvatarPreset(botKey || roleName || 'bot', roleName, isPrimary);
  const shape = GROK_SHAPES[resolved.shape] ?? GROK_SHAPES.blob;
  const exprIdx = Math.min(Math.max(0, resolved.expressionIndex), GROK_EXPRESSIONS.length - 1);
  const [leftPath, rightPath] = GROK_EXPRESSIONS[exprIdx];
  const [leftEye, rightEye] = shape.eyes[exprIdx] ?? shape.eyes[0];
  const c = GROK_HEAD_CENTER;
  const headTransform = resolved.rotation
    ? `translate(${c} ${c}) rotate(${resolved.rotation}) translate(${-c} ${-c})`
    : undefined;
  const leftTransform = `translate(${leftEye.x} ${leftEye.y}) scale(${leftEye.scale} ${leftEye.scale}) translate(${-leftEye.cx} ${-leftEye.cy})`;
  const rightTransform = `translate(${rightEye.x} ${rightEye.y}) scale(${rightEye.scale} ${rightEye.scale}) translate(${-rightEye.cx} ${-rightEye.cy})`;
  const platformKind = typeof platformBadge === 'string' ? normalizeAvatarPlatform(platformBadge) : null;
  const badgeSize = Math.max(15, Math.round(size * 0.27));
  const showReflectBadge = reflecting && !busy && !offline;
  const reflectSize = Math.max(14, Math.round(size * 0.3));

  return (
    <span
      className={`grok-bot-avatar${busy && !offline ? ' is-busy' : ''}${showReflectBadge ? ' is-reflecting' : ''}${offline ? ' is-offline' : ''}${isPrimary ? ' is-primary' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      <svg
        viewBox="-14 -14 256.54 256.54"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
        className="grok-bot-svg"
      >
        <defs>
          <clipPath id={clipId}>
            <path d={shape.path} transform={headTransform} />
          </clipPath>
        </defs>
        <g className="grok-bot-body-group">
          <path d={shape.path} fill={offline ? OFFLINE_COLOR : resolved.color} transform={headTransform} />
          <g clipPath={`url(#${clipId})`} className="grok-bot-eyes-group">
            <path d={leftPath} fill="#ffffff" transform={leftTransform} />
            <path d={rightPath} fill="#ffffff" transform={rightTransform} />
          </g>
        </g>
        {starBadge && (
          <g transform="translate(184 184)">
            <circle cx="0" cy="0" r="34" fill="#ffffff" />
            <circle cx="0" cy="0" r="28" fill={GROK_STAR_GOLD} />
            <path d={GROK_STAR_PATH} fill="#ffffff" transform="scale(15)" />
          </g>
        )}
      </svg>
      {showReflectBadge && (
        <span
          className="grok-bot-reflect-badge"
          style={{
            position: 'absolute',
            right: -3,
            top: -3,
            width: `${reflectSize}px`,
            height: `${reflectSize}px`,
            borderRadius: '50%',
            background: 'var(--bg, #ffffff)',
            border: '1.5px solid var(--line, rgba(0, 0, 0, 0.12))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: resolved.color,
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.14)',
            pointerEvents: 'none',
          }}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" style={{ width: '72%', height: '72%' }} aria-hidden="true">
            <path d="M10 2.5a6.5 6.5 0 0 0-5.4 10.12c-.2.94-.68 1.87-1.35 2.55a.45.45 0 0 0 .38.76c1.48-.16 2.86-.63 3.92-1.22.78.2 1.6.3 2.45.3a6.5 6.5 0 0 0 0-12.5Zm-2.5 5.75a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm2.5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm2.5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
          </svg>
        </span>
      )}
      {(platformKind || (platformBadge && typeof platformBadge !== 'string')) && (
        <span
          className={`grok-bot-platform-badge grok-bot-avatar-platform-badge${platformKind ? ` is-${platformKind}` : ''}`}
          data-platform={platformKind || 'custom'}
          style={{
            position: 'absolute',
            left: -2,
            bottom: -2,
            width: `${badgeSize}px`,
            height: `${badgeSize}px`,
            borderRadius: '50%',
            background: 'var(--bg, #ffffff)',
            border: '1.5px solid var(--line, rgba(0, 0, 0, 0.12))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text, #1d1d1f)',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.16)',
            pointerEvents: 'none',
          }}
        >
          {platformKind ? <AvatarPlatformGlyph kind={platformKind} /> : platformBadge}
        </span>
      )}
    </span>
  );
}

export function GrokBotAnimatedMark({
  seedId,
  shape = 'cloud',
  color = '#2B70F6',
  eyeColor = '#FAF8F5',
  state = 'working',
  size = 36,
  isPlaying = true,
  isEmphasized = false,
  interactivePoke = false,
  className = '',
}: {
  seedId?: string;
  shape?: string;
  color?: string;
  eyeColor?: string;
  state?: GrokMascotState;
  size?: number;
  isPlaying?: boolean;
  isEmphasized?: boolean;
  interactivePoke?: boolean;
  className?: string;
}) {
  const reactId = useId().replace(/:/g, '_');
  const markId = seedId ? `grok_mark_${seedId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${reactId}` : `grok_mark_${reactId}`;
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLSpanElement | null>(null);
  const controllerRef = useRef<ReturnType<typeof createGrokMascotController> | null>(null);
  const pokeIndexRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctrl = createGrokMascotController({
      id: markId,
      body: normalizeGrokBodyShape(shape),
      inkColor: color,
      eyeColor,
      state,
      size,
      isPlaying,
      isEmphasized,
      seed: seedId || markId,
    });
    controllerRef.current = ctrl;
    const detach = ctrl.attach({ host, canvas });
    return () => {
      detach();
      controllerRef.current = null;
    };
  }, [markId, seedId]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.update({
      body: normalizeGrokBodyShape(shape),
      appearance: createGrokAppearance(color, eyeColor),
      state,
      size,
      isPlaying,
      isEmphasized,
    });
  }, [shape, color, eyeColor, state, size, isPlaying, isEmphasized]);

  const handlePoke = () => {
    if (!interactivePoke || !controllerRef.current) return;
    const kind = GROK_POKE_TYPES[pokeIndexRef.current % GROK_POKE_TYPES.length] ?? 'spin';
    pokeIndexRef.current += 1;
    controllerRef.current.poke(kind, undefined);
  };

  return (
    <span
      ref={hostRef}
      className={`sand-grok-bot-mark${interactivePoke ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`}
      data-grok-state={state}
      style={{ width: `${size}px`, height: `${size}px` }}
      onClick={interactivePoke ? handlePoke : undefined}
      role={interactivePoke ? 'button' : undefined}
      tabIndex={interactivePoke ? 0 : undefined}
      aria-hidden={interactivePoke ? undefined : 'true'}
      aria-label={interactivePoke ? 'Bot working indicator' : undefined}
    >
      <span ref={canvasRef} className="sand-grok-bot-mark-canvas" />
    </span>
  );
}

const workingStartMsByBotKey = new Map<string, number>();
const seenLearningOutcomeSeqByBotKey = new Map<string, number>();

export function formatWorkingElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, '0')}m`;
}

function hasMeaningfulLearningSave(outcome: BotLearningOutcomeSummary | null | undefined): outcome is BotLearningOutcomeSummary {
  if (!outcome || outcome.status !== 'completed') return false;
  return (
    (outcome.updatedSkills?.length ?? 0) > 0 ||
    (outcome.archivedSkills?.length ?? 0) > 0 ||
    outcome.memoryUpdated === true
  );
}

export function GrokBotWorkingSlot({
  botKey,
  preset,
  isBusy,
  isStreaming,
  activeToolName,
  hasThinking,
  queuedCount = 0,
  hasError = false,
  isSending = false,
  isRecovering = false,
  startedAt,
  activity,
  learning,
  onOpenLearnedSkills,
  t,
}: {
  botKey: string;
  preset: GrokAvatarPreset;
  isBusy: boolean;
  isStreaming: boolean;
  activeToolName?: string | null;
  hasThinking?: boolean;
  queuedCount?: number;
  hasError?: boolean;
  isSending?: boolean;
  isRecovering?: boolean;
  startedAt?: number | null;
  activity?: BotActivity;
  learning?: BotLearningLiveState | null;
  onOpenLearnedSkills?: () => void;
  t: (zh: string, en: string) => string;
}) {
  const isPreLlmWaiting =
    isBusy &&
    (isBotPreLlmPhase(activity?.phase) ||
      (Boolean(isSending) && !isBotLlmRunningPhase(activity?.phase) && activity?.phase !== 'stopping'));

  const resolveStartMs = () => {
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
      const clamped = Math.min(startedAt, Date.now());
      workingStartMsByBotKey.set(botKey, clamped);
      return clamped;
    }
    const cached = workingStartMsByBotKey.get(botKey);
    if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
      return cached;
    }
    const now = Date.now();
    if (isBusy && !isPreLlmWaiting) workingStartMsByBotKey.set(botKey, now);
    return now;
  };

  const [elapsedSec, setElapsedSec] = useState(() =>
    isBusy && !isPreLlmWaiting ? Math.max(0, Math.floor((Date.now() - resolveStartMs()) / 1000)) : 0,
  );
  const [settlementOutcome, setSettlementOutcome] = useState<'success' | 'error' | 'stopped' | null>(null);
  const [learningOutcome, setLearningOutcome] = useState<BotLearningOutcomeSummary | null>(null);
  const [reflectionReadingPhase, setReflectionReadingPhase] = useState(false);
  const [emphasized, setEmphasized] = useState(false);
  const [pulseThinkingMorph, setPulseThinkingMorph] = useState(false);
  const wasBusyRef = useRef(isBusy && !isPreLlmWaiting);

  useEffect(() => {
    if (isPreLlmWaiting) {
      workingStartMsByBotKey.delete(botKey);
      setSettlementOutcome(null);
      setElapsedSec(0);
      return undefined;
    }
    if (isBusy) {
      wasBusyRef.current = true;
      setSettlementOutcome(null);
      setLearningOutcome(null);
      const startMs = resolveStartMs();
      const update = () => {
        setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
      };
      update();
      const timer = window.setInterval(update, 250);
      return () => window.clearInterval(timer);
    }
    if (isRecovering) {
      wasBusyRef.current = false;
      setSettlementOutcome(null);
      return undefined;
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      const finalStartMs = workingStartMsByBotKey.get(botKey);
      if (typeof finalStartMs === 'number' && Number.isFinite(finalStartMs) && finalStartMs > 0) {
        setElapsedSec(Math.max(0, Math.floor((Date.now() - finalStartMs) / 1000)));
      }
      workingStartMsByBotKey.delete(botKey);
      // 'failed' 是驻留终态：由下方 settledActivity 持续渲染，不走 1.45s 自动清除的 error 结算。
      setSettlementOutcome(
        activity?.phase === 'stopped' ? 'stopped' : hasError ? 'error' : 'success',
      );
      const settleTimer = window.setTimeout(() => {
        setSettlementOutcome(null);
        setElapsedSec(0);
      }, 1450);
      return () => window.clearTimeout(settleTimer);
    }
    workingStartMsByBotKey.delete(botKey);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, isPreLlmWaiting, startedAt, botKey, hasError, isRecovering, activity?.phase]);

  // 跟踪静默自学习结果：仅在真正保存了新技能、归档了过期技能或更新记忆时短暂展示 'proud' 气泡，
  // "Nothing to save" 或被抢占/取消则静默收起，绝不打扰前台用户。
  useEffect(() => {
    const outcome = learning?.lastOutcome ?? null;
    if (!outcome) return undefined;
    const prevSeq = seenLearningOutcomeSeqByBotKey.get(botKey);
    if (prevSeq === outcome.seq) return undefined;
    seenLearningOutcomeSeqByBotKey.set(botKey, outcome.seq);
    const finishedMs = Date.parse(outcome.finishedAt);
    const isFresh = Number.isFinite(finishedMs) ? Date.now() - finishedMs <= 12_000 : true;
    if (!isBusy && isFresh && hasMeaningfulLearningSave(outcome)) {
      setLearningOutcome(outcome);
      const timer = window.setTimeout(() => {
        setLearningOutcome(current => (current?.seq === outcome.seq ? null : current));
      }, 8000);
      return () => window.clearTimeout(timer);
    }
    setLearningOutcome(null);
    return undefined;
  }, [botKey, isBusy, learning?.lastOutcome]);

  const isPhaseLed =
    isBusy &&
    (isPreLlmWaiting ||
      activity?.phase === 'queued' ||
      activity?.phase === 'preparing' ||
      activity?.phase === 'compacting' ||
      activity?.phase === 'interrupting' ||
      activity?.phase === 'stopping');
  // Settled failures/stops and pending Webhook stop sync stay visible without a spinner.
  const settledActivity =
    !isBusy && (activity?.phase === 'stopped' || activity?.phase === 'failed' || activity?.webhookStopPending)
      ? activity : null;

  const isReflecting =
    !isBusy && !isRecovering && !settlementOutcome && !settledActivity && Boolean(learning?.active);
  const showLearningOutcome =
    !isBusy && !isRecovering && !settlementOutcome && !settledActivity && !isReflecting && Boolean(learningOutcome);

  useEffect(() => {
    if (!isReflecting || learning?.phase === 'writing') {
      setReflectionReadingPhase(false);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setReflectionReadingPhase(prev => !prev);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [isReflecting, learning?.phase]);

  useEffect(() => {
    if (!isBusy || isStreaming || activeToolName || isPhaseLed) {
      setPulseThinkingMorph(false);
      return undefined;
    }
    // Animate the selected avatar, with periodic thinking-dot morphs during long reasoning pauses.
    const cycle = window.setInterval(() => {
      setPulseThinkingMorph(prev => !prev);
    }, 4200);
    return () => window.clearInterval(cycle);
  }, [isBusy, isStreaming, activeToolName, isPhaseLed]);

  if (!isBusy && (isRecovering || (!settlementOutcome && !settledActivity && !isReflecting && !showLearningOutcome))) {
    return null;
  }

  const baseState = resolveGrokMascotState({
    isBusy,
    isStreaming,
    activeToolName,
    hasThinking,
    settlementOutcome:
      settlementOutcome === 'stopped'
        ? 'success'
        : settlementOutcome,
  });

  const mascotState: GrokMascotState = (() => {
    if (!isBusy && showLearningOutcome) return 'proud';
    if (!isBusy && isReflecting) {
      if (learning?.phase === 'writing') return 'writing';
      if (learning?.mode === 'curate') return reflectionReadingPhase ? 'curious' : 'reading';
      return reflectionReadingPhase ? 'reading' : 'curious';
    }
    if (isPreLlmWaiting) return 'waiting';
    if (isPhaseLed) {
      if (activity?.phase === 'stopping') return 'powering-down';
      // 压缩仍是真实执行中：用 working 而非等待态，配合「整理上下文中」文案。
      if (activity?.phase === 'compacting') return 'working';
      return 'waiting';
    }
    if (settledActivity) {
      return 'idle';
    }
    if (settlementOutcome === 'stopped') return 'idle';
    return baseState === 'working' && pulseThinkingMorph && !activeToolName && !isStreaming
      ? 'thinking'
      : baseState;
  })();

  const statusText = (() => {
    if (!isBusy) {
      if (settledActivity) return botActivityText(settledActivity, t);
      if (settlementOutcome === 'stopped') return t('已停止', 'Stopped');
      if (settlementOutcome) {
        return settlementOutcome === 'error'
          ? t('执行中断', 'Interrupted')
          : t('已完成', 'Done');
      }
      if (isReflecting) {
        if (learning?.phase === 'writing') {
          if (learning.toolName === 'memory') {
            return t('正在沉淀长期记忆…', 'Saving memory…');
          }
          if (learning.mode === 'curate') {
            return t('正在归档与精简技能…', 'Consolidating skills…');
          }
          return t('正在提炼新技能…', 'Writing learned skill…');
        }
        if (learning?.mode === 'curate') {
          return t('正在静默整理技能库…', 'Curating skills…');
        }
        if (learning?.mode === 'learn') {
          return t('正在总结学习经验…', 'Synthesizing skill…');
        }
        return t('空闲静默复盘中…', 'Reflecting while idle…');
      }
      if (showLearningOutcome && learningOutcome) {
        const updated = learningOutcome.updatedSkills ?? [];
        const archived = learningOutcome.archivedSkills ?? [];
        if (updated.length > 0) {
          const preview = updated.slice(0, 2).join('、');
          const suffix = updated.length > 2 ? t(` 等 ${updated.length} 项`, ` +${updated.length - 2}`) : '';
          return t(`✨ 已习得/更新技能 ${preview}${suffix}`, `✨ Learned/updated skill ${preview}${suffix}`);
        }
        if (archived.length > 0) {
          return t(`✨ 已整理归档 ${archived.length} 项过期技能`, `✨ Archived ${archived.length} stale skill(s)`);
        }
        return t('✨ 已沉淀新的长期记忆', '✨ Saved long-term memory');
      }
      return t('已完成', 'Done');
    }
    if (isPhaseLed && activity) return botActivityText(activity, t);
    if (isSending) return t('正在发送…', 'Sending…');
    if (isStreaming) {
      return t('正在回复…', 'Replying…');
    }
    const tool = (activeToolName || '').trim();
    if (tool) {
      const lower = tool.toLowerCase();
      if (/search|grep|glob|find|web_search|query|recall/.test(lower)) {
        return `${t('正在搜索', 'Searching')} · ${tool}`;
      }
      if (/write|edit|patch|create|save/.test(lower)) {
        return `${t('正在编写', 'Writing')} · ${tool}`;
      }
      if (/read|view|cat|fetch|browse|open|ls/.test(lower)) {
        return `${t('正在读取', 'Reading')} · ${tool}`;
      }
      if (/shower|android_apps/.test(lower)) {
        return `${t('正在操作屏幕', 'Controlling screen')} · ${tool}`;
      }
      if (/bash|exec|shell|cmd|run|terminal/.test(lower)) {
        return `${t('正在执行命令', 'Running command')} · ${tool}`;
      }
      return `${t('正在调用工具', 'Using tool')} · ${tool}`;
    }
    if (hasThinking) {
      return t('正在深入思考…', 'Thinking…');
    }
    if (!activity && queuedCount > 0) {
      return t('正在等待…', 'Waiting…');
    }
    return t('正在思考…', 'Working…');
  })();

  const canInspectSkills =
    showLearningOutcome &&
    Boolean(onOpenLearnedSkills) &&
    ((learningOutcome?.updatedSkills?.length ?? 0) > 0 || (learningOutcome?.archivedSkills?.length ?? 0) > 0);

  return (
    <div
      className={`sand-activity-slot${!isBusy && (settlementOutcome || settledActivity) ? ' is-settling' : ''}${isReflecting || showLearningOutcome ? ' is-reflecting' : ''}`}
      data-role="assistant"
      data-grok-state={mascotState}
      aria-live="polite"
      onPointerEnter={() => setEmphasized(true)}
      onPointerLeave={() => setEmphasized(false)}
    >
      <div className="sand-activity-mark">
        <GrokBotAnimatedMark
          seedId={botKey}
          shape={preset.shape}
          color={preset.color}
          eyeColor="#FAF8F5"
          state={mascotState}
          size={36}
          isPlaying={isBusy || Boolean(settlementOutcome) || isReflecting || showLearningOutcome}
          isEmphasized={emphasized}
          interactivePoke={true}
        />
        {!isPreLlmWaiting ? (
          <span className="sand-activity-mark-label">
            <span className={`sand-activity-label-text${isBusy || isReflecting ? ' is-shimmering' : ''}`}>
              {statusText}
              {activity?.webhookStopPending && !isPhaseLed && !settledActivity
                ? t(' · Webhook停止待同步', ' · Webhook stop awaiting sync') : null}
            </span>
            {canInspectSkills ? (
              <button
                type="button"
                className="sand-activity-learn-link"
                onClick={() => {
                  setLearningOutcome(null);
                  onOpenLearnedSkills?.();
                }}
              >
                {t('查看', 'View')}
              </button>
            ) : null}
            {(isBusy || Boolean(settlementOutcome) || Boolean(settledActivity)) && (
              <span className="sand-activity-elapsed">{formatWorkingElapsed(elapsedSec)}</span>
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
