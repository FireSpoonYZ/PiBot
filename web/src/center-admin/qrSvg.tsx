import type * as React from 'react';
import { useText } from '../ui';

interface EccSpec {
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
}

// ISO/IEC 18004 ECC Level L specs for versions 1..25 (up to 1,273 UTF-8 bytes)
const ECC_L_TABLE: readonly EccSpec[] = [
  { ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0 }, // 1
  { ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0 }, // 2
  { ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0 }, // 3
  { ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0 }, // 4
  { ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0 }, // 5
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0 }, // 6
  { ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0 }, // 7
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0 }, // 8
  { ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0 }, // 9
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69 }, // 10
  { ecPerBlock: 20, g1Blocks: 4, g1Data: 81, g2Blocks: 0, g2Data: 0 }, // 11
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 92, g2Blocks: 2, g2Data: 93 }, // 12
  { ecPerBlock: 26, g1Blocks: 4, g1Data: 107, g2Blocks: 0, g2Data: 0 }, // 13
  { ecPerBlock: 30, g1Blocks: 3, g1Data: 115, g2Blocks: 1, g2Data: 116 }, // 14
  { ecPerBlock: 22, g1Blocks: 5, g1Data: 87, g2Blocks: 1, g2Data: 88 }, // 15
  { ecPerBlock: 24, g1Blocks: 5, g1Data: 98, g2Blocks: 1, g2Data: 99 }, // 16
  { ecPerBlock: 28, g1Blocks: 1, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // 17
  { ecPerBlock: 30, g1Blocks: 5, g1Data: 120, g2Blocks: 1, g2Data: 121 }, // 18
  { ecPerBlock: 28, g1Blocks: 3, g1Data: 113, g2Blocks: 4, g2Data: 114 }, // 19
  { ecPerBlock: 28, g1Blocks: 3, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // 20
  { ecPerBlock: 28, g1Blocks: 4, g1Data: 116, g2Blocks: 4, g2Data: 117 }, // 21
  { ecPerBlock: 28, g1Blocks: 2, g1Data: 111, g2Blocks: 7, g2Data: 112 }, // 22
  { ecPerBlock: 30, g1Blocks: 4, g1Data: 121, g2Blocks: 5, g2Data: 122 }, // 23
  { ecPerBlock: 30, g1Blocks: 6, g1Data: 117, g2Blocks: 4, g2Data: 118 }, // 24
  { ecPerBlock: 26, g1Blocks: 8, g1Data: 106, g2Blocks: 4, g2Data: 107 }, // 25
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const last = size - 7;
  const step = Math.ceil((last - 6) / (count - 1) / 2) * 2;
  const pos = [6];
  for (let i = 1; i < count; i += 1) {
    pos.push(last - (count - 1 - i) * step);
  }
  return pos;
}

function bchFormat(mask: number): number {
  const data = (0b01 << 3) | mask; // ECC L = 01
  let d = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i -= 1) {
    if (d & (1 << i)) d ^= poly << (i - 10);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version: number): number {
  let d = version << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i -= 1) {
    if (d & (1 << i)) d ^= poly << (i - 12);
  }
  return (version << 12) | d;
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(grid: Uint8Array, size: number): number {
  let score = 0;
  const at = (r: number, c: number) => grid[r * size + c] === 1;

  // Rule 1: runs of 5+
  for (let r = 0; r < size; r += 1) {
    let runColor = at(r, 0);
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      const cur = at(r, c);
      if (cur === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = cur;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = at(0, c);
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      const cur = at(r, c);
      if (cur === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = cur;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const a = at(r, c);
      if (a === at(r, c + 1) && a === at(r + 1, c) && a === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1011101 with 4 lights before or after
  const isPatA = (arr: boolean[], i: number) =>
    arr[i] && !arr[i + 1] && arr[i + 2] && arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] &&
    !arr[i + 7] && !arr[i + 8] && !arr[i + 9] && !arr[i + 10];
  const isPatB = (arr: boolean[], i: number) =>
    !arr[i] && !arr[i + 1] && !arr[i + 2] && !arr[i + 3] &&
    arr[i + 4] && !arr[i + 5] && arr[i + 6] && arr[i + 7] && arr[i + 8] && !arr[i + 9] && arr[i + 10];

  const rowBuf: boolean[] = new Array(size);
  const colBuf: boolean[] = new Array(size);
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      rowBuf[j] = at(i, j);
      colBuf[j] = at(j, i);
    }
    for (let j = 0; j <= size - 11; j += 1) {
      if (isPatA(rowBuf, j) || isPatB(rowBuf, j)) score += 40;
      if (isPatA(colBuf, j) || isPatB(colBuf, j)) score += 40;
    }
  }

  // Rule 4: dark ratio
  let dark = 0;
  for (let i = 0; i < grid.length; i += 1) {
    if (grid[i] === 1) dark += 1;
  }
  const pct = (dark * 100) / grid.length;
  const k = Math.floor(Math.abs(pct - 50) / 5);
  score += k * 10;
  return score;
}

export interface QrMatrix {
  size: number;
  modules: Uint8Array;
}

export function encodeQrMatrix(text: string): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  let version = -1;
  for (let v = 1; v <= ECC_L_TABLE.length; v += 1) {
    const spec = ECC_L_TABLE[v - 1];
    const totalDataCodewords = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= totalDataCodewords * 8) {
      version = v;
      break;
    }
  }
  if (version < 0) return null;

  const spec = ECC_L_TABLE[version - 1];
  const totalDataCw = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i += 1) pushBits(bytes[i], 8);
  const maxDataBits = totalDataCw * 8;
  const termLen = Math.min(4, maxDataBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);
  let padByte = 0xec;
  while (bits.length < maxDataBits) {
    pushBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const dataCw = new Uint8Array(totalDataCw);
  for (let i = 0; i < totalDataCw; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i * 8 + j];
    dataCw[i] = b;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i += 1) {
    const block = dataCw.subarray(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.g2Blocks; i += 1) {
    const block = dataCw.subarray(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }

  const interleaved: number[] = [];
  const maxDataBlockLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataBlockLen; i += 1) {
    for (let b = 0; b < dataBlocks.length; b += 1) {
      if (i < dataBlocks[b].length) interleaved.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < ecBlocks.length; b += 1) {
      interleaved.push(ecBlocks[b][i]);
    }
  }

  const size = version * 4 + 17;
  const base = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    const idx = r * size + c;
    base[idx] = dark ? 1 : 0;
    reserved[idx] = 1;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inBox && (
          dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        );
        setFunc(top + dr, left + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  const aligns = alignmentPositions(version);
  for (const r of aligns) {
    for (const c of aligns) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFunc(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Dark module
  setFunc(size - 8, 8, true);

  // Reserve format info
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i += 1) {
    setFunc(8, i, false);
    if (i < size - 1) setFunc(i + 1, 8, false);
  }

  // Version info
  if (version >= 7) {
    const vBits = bchVersion(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // Place data bits in zig-zag
  const bitStream: number[] = [];
  for (let i = 0; i < interleaved.length; i += 1) {
    const byte = interleaved[i];
    for (let b = 7; b >= 0; b -= 1) bitStream.push((byte >> b) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        const idx = r * size + c;
        if (!reserved[idx]) {
          base[idx] = bitIdx < bitStream.length ? bitStream[bitIdx] : 0;
          bitIdx += 1;
        }
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestGrid = base;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = new Uint8Array(base);
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const idx = r * size + c;
        if (!reserved[idx] && maskBit(mask, r, c)) {
          candidate[idx] ^= 1;
        }
      }
    }
    const fmt = bchFormat(mask);
    const putFmt = (r: number, c: number, bitIndex: number) => {
      candidate[r * size + c] = (fmt >> bitIndex) & 1;
    };
    for (let i = 0; i <= 5; i += 1) putFmt(8, i, 14 - i);
    putFmt(8, 7, 8);
    putFmt(8, 8, 7);
    putFmt(7, 8, 6);
    for (let i = 0; i <= 5; i += 1) putFmt(5 - i, 8, 5 - i);
    for (let i = 0; i < 7; i += 1) putFmt(size - 1 - i, 8, 14 - i);
    for (let i = 0; i < 8; i += 1) putFmt(8, size - 8 + i, 7 - i);

    const score = penaltyScore(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = candidate;
    }
  }
  void bestMask;
  return { size, modules: bestGrid };
}

export function QrSvg({ value, label }: { value: string; label: string }): React.JSX.Element {
  const t = useText();
  const matrix = encodeQrMatrix(value);
  if (!matrix) {
    return (
      <div className="ca-qr-fallback">
        {t('内容较长暂无法生成二维码，请使用复制文本或链接方式导入。', 'Content is too long for a QR code. Copy the text or link to import instead.')}
      </div>
    );
  }
  const quiet = 4;
  const viewSize = matrix.size + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.modules[r * matrix.size + c] === 1) {
        parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      shapeRendering="crispEdges"
      className="ca-qr-svg"
    >
      <rect width={viewSize} height={viewSize} fill="#ffffff" />
      <path d={parts.join('')} fill="#111111" />
    </svg>
  );
}
