/**
 * EXIF（画像に付随する撮影情報）の解析。
 *
 * 中身はTIFF形式のディレクトリ構造。JPEGならAPP1セグメント、
 * PNGならeXIfチャンクに、同じ形式で格納されている。
 * OSINTではGPS座標が答えに直結することがあり、
 * フォレンジックでは撮影機材や日時が手がかりになる。
 */
import { ascii, findAll } from "./bytes.ts";

export interface ExifTag { tag: number; name: string; value: string | number | number[]; raw?: number[]; }
export interface GpsPosition { lat: number; lon: number; latRef: string; lonRef: string; altitude?: number; }
export interface ExifData {
  littleEndian: boolean;
  tags: ExifTag[];
  gps?: GpsPosition;
}

const TAG_NAMES: Record<number, string> = {
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation",
  0x0131: "Software", 0x0132: "DateTime", 0x013b: "Artist", 0x8298: "Copyright",
  0x8769: "ExifIFDPointer", 0x8825: "GPSInfoIFDPointer",
  0x829a: "ExposureTime", 0x829d: "FNumber", 0x8827: "ISOSpeedRatings",
  0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized", 0x9286: "UserComment",
  0xa002: "PixelXDimension", 0xa003: "PixelYDimension", 0xa430: "CameraOwnerName",
  0xa431: "BodySerialNumber", 0xa433: "LensMake", 0xa434: "LensModel",
};
const GPS_NAMES: Record<number, string> = {
  0: "GPSVersionID", 1: "GPSLatitudeRef", 2: "GPSLatitude", 3: "GPSLongitudeRef",
  4: "GPSLongitude", 5: "GPSAltitudeRef", 6: "GPSAltitude", 7: "GPSTimeStamp",
  18: "GPSMapDatum", 29: "GPSDateStamp",
};

/** 型ごとの1要素あたりのバイト数 */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * ファイル中のEXIFブロックの開始位置を探す。
 * JPEGでは "Exif\0\0" の直後、PNGのeXIfチャンクでは
 * チャンクデータの先頭が、いずれもTIFFヘッダになっている。
 */
export function findExifOffsets(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const at of findAll(b, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4)) out.push(at + 6);
  // TIFFヘッダを直接探す（PNGのeXIfチャンクなど）
  for (const sig of [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]]) {
    for (const at of findAll(b, sig, 8)) if (!out.includes(at)) out.push(at);
  }
  return out.sort((a, c) => a - c);
}

export function parseExif(b: Uint8Array, base: number): ExifData | null {
  if (base + 8 > b.length) return null;
  const bo = ascii(b, base, 2);
  if (bo !== "II" && bo !== "MM") return null;
  const le = bo === "II";
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => (o + 2 <= b.length ? dv.getUint16(o, le) : 0);
  const u32 = (o: number) => (o + 4 <= b.length ? dv.getUint32(o, le) : 0);
  if (u16(base + 2) !== 42) return null;

  const tags: ExifTag[] = [];
  const seen = new Set<number>();
  let gpsOffset = 0;

  const readIfd = (ifdOff: number, names: Record<number, string>, depth: number) => {
    if (depth > 3 || seen.has(ifdOff)) return;
    seen.add(ifdOff);
    const at = base + ifdOff;
    if (at + 2 > b.length) return;
    const count = u16(at);
    if (count > 512) return; // 壊れたデータで暴走しないための上限
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (!size || size > b.length) continue;
      // 4バイトに収まる値はエントリ内に直接置かれる
      const vOff = size <= 4 ? e + 8 : base + u32(e + 8);
      if (vOff + size > b.length) continue;

      const name = names[tag] ?? `Tag0x${tag.toString(16)}`;
      let value: string | number | number[];
      const raw: number[] = [];
      if (type === 2) {
        value = ascii(b, vOff, n).replace(/\0+$/, "");
      } else if (type === 5 || type === 10) {
        for (let k = 0; k < n; k++) {
          const num = u32(vOff + k * 8), den = u32(vOff + k * 8 + 4);
          raw.push(den ? num / den : 0);
        }
        value = raw.length === 1 ? raw[0] : raw;
      } else if (type === 3) {
        for (let k = 0; k < n; k++) raw.push(u16(vOff + k * 2));
        value = raw.length === 1 ? raw[0] : raw;
      } else if (type === 4 || type === 9) {
        for (let k = 0; k < n; k++) raw.push(u32(vOff + k * 4));
        value = raw.length === 1 ? raw[0] : raw;
      } else {
        for (let k = 0; k < Math.min(n, 32); k++) raw.push(b[vOff + k]);
        value = raw;
      }

      if (tag === 0x8769 && names === TAG_NAMES) readIfd(typeof value === "number" ? value : u32(e + 8), TAG_NAMES, depth + 1);
      else if (tag === 0x8825 && names === TAG_NAMES) { gpsOffset = u32(e + 8); readIfd(gpsOffset, GPS_NAMES, depth + 1); }
      else tags.push({ tag, name: names === GPS_NAMES ? name : name, value, raw: raw.length ? raw : undefined });
    }
  };

  readIfd(u32(base + 4), TAG_NAMES, 0);
  return { littleEndian: le, tags, gps: buildGps(tags) };
}

/**
 * 度分秒(DMS)を十進度に変換する。
 * OSINTで最も間違えやすい箇所: 南緯・西経は符号を反転させる必要がある。
 */
export function dmsToDecimal(dms: number[], ref: string): number {
  const [d = 0, m = 0, s = 0] = dms;
  const v = d + m / 60 + s / 3600;
  return ref === "S" || ref === "W" ? -v : v;
}

function buildGps(tags: ExifTag[]): GpsPosition | undefined {
  const get = (name: string) => tags.find((t) => t.name === name);
  const lat = get("GPSLatitude"), lon = get("GPSLongitude");
  if (!lat?.raw || !lon?.raw || lat.raw.length < 3 || lon.raw.length < 3) return undefined;
  const latRef = String(get("GPSLatitudeRef")?.value ?? "N");
  const lonRef = String(get("GPSLongitudeRef")?.value ?? "E");
  const alt = get("GPSAltitude");
  return {
    lat: dmsToDecimal(lat.raw, latRef),
    lon: dmsToDecimal(lon.raw, lonRef),
    latRef, lonRef,
    altitude: typeof alt?.value === "number" ? alt.value : undefined,
  };
}

/** 度分秒の見た目に整形する（人間が確認しやすい形） */
export function formatDms(dms: number[], ref: string): string {
  const [d = 0, m = 0, s = 0] = dms;
  return `${d}°${m}'${s.toFixed(2)}"${ref}`;
}
