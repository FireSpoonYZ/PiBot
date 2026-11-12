import { useMemo } from 'react';
import { encode } from 'uqr';

/** Black on white regardless of theme: scanners need the contrast and a clean quiet zone. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const rendered = useMemo(() => {
    try {
      // border adds the quiet zone as light modules. Prefer ECC M for glare on a screen, but a
      // code carrying two certificates only fits at L; anything bigger falls through to the notice.
      let data: boolean[][];
      try {
        ({ data } = encode(value, { ecc: 'M', border: 4 }));
      } catch {
        ({ data } = encode(value, { ecc: 'L', border: 4 }));
      }
      // One rectangle per horizontal run of dark modules keeps the SVG small and crisp.
      let path = '';
      data.forEach((row, y) => {
        for (let x = 0; x < row.length;) {
          if (!row[x]) { x += 1; continue; }
          const start = x;
          while (x < row.length && row[x]) x += 1;
          path += `M${start} ${y}h${x - start}v1h-${x - start}z`;
        }
      });
      return { size: data.length, path };
    } catch {
      return null;
    }
  }, [value]);

  if (!rendered) {
    return (
      <p className="secondary">
        配对码过长，无法生成二维码（通常是保存的 CA 包含多张证书）。桌面端仍可复制粘贴；需要手机扫码时，请只保存根证书。
      </p>
    );
  }
  return (
    <svg
      className={className}
      viewBox={`0 0 ${rendered.size} ${rendered.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={rendered.size} height={rendered.size} fill="#ffffff" />
      <path d={rendered.path} fill="#000000" />
    </svg>
  );
}

export default QrCode;
