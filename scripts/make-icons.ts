/**
 * アプリアイコンとファビコンを生成する。
 *
 * SVGとPNGを同じ幾何定義から出力する。別々に書くと必ず食い違うため、
 * 文字の形は「軸に平行な矩形の集合」として1箇所に定義し、
 * SVGではパスに、PNGではラスタライズに使う。
 *
 *   node --experimental-strip-types scripts/make-icons.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeRgbPng } from "../src/core/png-encode.ts";

// ── 配色 ──
const BLACK = "#000000";
const ENJI = "#b94047";   // 臙脂色（テーマカラー）
const RED = "#e03131";    // 赤（サブテーマカラー）
const WHITE = "#ffffff";

// ── 基準キャンバス 512×512 ──
const S = 512;

type Rect = [x: number, y: number, w: number, h: number];

/**
 * 配置は用途で変える。
 *   app     … ホーム画面用。マスカブルの安全域（中央80%）に収める
 *   favicon … 16px まで縮むので、余白を削って字を最大化し、装飾も落とす
 */
interface Layout {
  top: number; h: number; lw: number; gap: number; bar: number;
  outline: number;
  accent: boolean;
}
const LAYOUTS: Record<"app" | "favicon", Layout> = {
  app:     { top: 149, h: 180, lw: 112, gap: 20, bar: 34, outline: 6,  accent: true },
  // ファビコンは16pxまで縮む。字を大きく・線を太くし、装飾は落とす
  favicon: { top: 116, h: 280, lw: 136, gap: 20, bar: 54, outline: 12, accent: false },
};

/** 3文字ぶんの合計幅から左端を求める。手で置くと canvas 幅を超えて端が切れる */
const originX = (L: Layout) => Math.round((S - (L.lw * 3 + L.gap * 2)) / 2);

/** C・T・F を矩形の集合として定義する。和集合がそのまま字形になる */
function letterRects(L: Layout, x: number, letter: "C" | "T" | "F"): Rect[] {
  const { top: y, h, lw, bar } = L;
  switch (letter) {
    case "C": return [
      [x, y, bar, h],                      // 左の縦棒
      [x, y, lw, bar],                     // 上の横棒
      [x, y + h - bar, lw, bar],           // 下の横棒
    ];
    case "T": return [
      [x, y, lw, bar],                     // 上の横棒
      [x + (lw - bar) / 2, y, bar, h],     // 中央の縦棒
    ];
    case "F": return [
      [x, y, bar, h],                      // 左の縦棒
      [x, y, lw, bar],                     // 上の横棒
      // 中央の横棒は、視覚的な中心がやや上に来るよう中央より少し上に置く
      [x, y + Math.round(h * 0.42), lw - Math.round(lw * 0.14), bar],
    ];
  }
}

function lettersOf(L: Layout): Rect[] {
  const step = L.lw + L.gap;
  const x0 = originX(L);
  return [
    ...letterRects(L, x0, "C"),
    ...letterRects(L, x0 + step, "T"),
    ...letterRects(L, x0 + step * 2, "F"),
  ];
}

/** 文字の下に敷く細いアクセント線。左側だけ赤にして走査線のような表情を出す */
function accentOf(L: Layout): { rect: Rect; color: string }[] {
  if (!L.accent) return [];
  const w = L.lw * 3 + L.gap * 2;
  const x0 = originX(L);
  const y = L.top + L.h + 26;
  return [
    { rect: [x0, y, w, 10], color: "#5a2126" },
    { rect: [x0, y, Math.round(w * 0.34), 10], color: RED },
  ];
}

// ══════════════ SVG ══════════════

/** 矩形の和集合を1本の閉パスにはせず、矩形をそのまま並べる（塗りは同じ結果になる） */
function rectsToPath(rects: Rect[]): string {
  return rects.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}z`).join("");
}

function svg(opts: { rounded: boolean; layout: Layout }): string {
  const L = opts.layout;
  const letters = lettersOf(L);
  const r = opts.rounded ? 112 : 0;
  const path = rectsToPath(letters);
  // 外側に広げた矩形の和集合が、そのまま白枠になる
  // （膨張は和集合に対して分配できるため、矩形ごとに広げてよい）
  const outline = rectsToPath(letters.map(([x, y, w, h]) =>
    [x - L.outline, y - L.outline, w + L.outline * 2, h + L.outline * 2] as Rect));
  const acc = accentOf(L).map((a) => `<path d="${rectsToPath([a.rect])}" fill="${a.color}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <rect width="${S}" height="${S}" rx="${r}" fill="${BLACK}"/>
  <path d="${outline}" fill="${WHITE}"/>
  <path d="${path}" fill="${ENJI}"/>
  ${acc}
</svg>
`;
}

// ══════════════ PNG ══════════════

const hex = (c: string): [number, number, number] =>
  [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

const inRects = (rects: Rect[], x: number, y: number) =>
  rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);

/**
 * 3×3のスーパーサンプリングで描く。白枠の縁がギザつくのを平均で滑らかにする。
 *
 * PNGは角丸にしない。マスカブルアイコンもiOSのホーム画面アイコンも、
 * プラットフォーム側が独自の形で切り抜く前提なので、全面を塗るのが正しい。
 * （そもそも背景が黒なので、透明度なしでは角を丸めても見た目は変わらない）
 * 角丸が要るのはSVG側だけ。
 */
function render(size: number, L: Layout): Uint8Array {
  const SS = 3;
  const k = S / size;                 // 基準キャンバスへの換算係数
  const letters = lettersOf(L);
  const outlineRects = letters.map(([x, y, w, h]) =>
    [x - L.outline, y - L.outline, w + L.outline * 2, h + L.outline * 2] as Rect);

  const bg = hex(BLACK), white = hex(WHITE), enji = hex(ENJI);
  const accents = accentOf(L).map((a) => ({ rect: a.rect, rgb: hex(a.color) }));
  const out = new Uint8Array(size * size * 3);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px + (sx + 0.5) / SS) * k;   // 基準キャンバス座標
          const uy = (py + (sy + 0.5) / SS) * k;
          let c = bg;
          for (const a of accents) if (inRects([a.rect], ux, uy)) c = a.rgb;
          if (inRects(outlineRects, ux, uy)) c = white;
          if (inRects(letters, ux, uy)) c = enji;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, d = (py * size + px) * 3;
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n); out[d + 2] = Math.round(b / n);
    }
  }
  return out;
}

// ══════════════ 出力 ══════════════
const dir = fileURLToPath(new URL("../public/", import.meta.url));

writeFileSync(dir + "icon.svg", svg({ rounded: true, layout: LAYOUTS.app }));
// ファビコンは16px程度まで縮むので角丸を付けない（角が潰れて汚くなる）
writeFileSync(dir + "favicon.svg", svg({ rounded: false, layout: LAYOUTS.favicon }));

const outputs: [string, number, Layout][] = [
  ["icon-192.png", 192, LAYOUTS.app],
  ["icon-512.png", 512, LAYOUTS.app],
  ["apple-touch-icon.png", 180, LAYOUTS.app],
  ["favicon-32.png", 32, LAYOUTS.favicon],
];
for (const [name, size, L] of outputs) {
  const rgb = render(size, L);
  const png = await encodeRgbPng(size, size, rgb);
  writeFileSync(dir + name, png);
  console.log(`${name.padEnd(24)} ${size}×${size}  ${png.length.toLocaleString()} バイト`);
}
console.log("icon.svg / favicon.svg も出力しました");
