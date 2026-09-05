import type { Analyzer, Ctx, AnalyzerResult, Step, FlagHit } from "../types.ts";
import { findExifOffsets, parseExif, formatDms, type ExifData } from "../exif.ts";
import { findFlags } from "../flag.ts";

/**
 * EXIF（撮影情報）の解析。
 *
 * OSINTでは「どこで撮られたか」がそのまま答えになることがあり、
 * フォレンジックでは機材・ソフト・日時が誰が作ったかの手がかりになる。
 * 画像を見ても分からない情報が、画像の外側に付いている。
 */
export const exif: Analyzer = {
  name: "exif",
  genre: "osint",
  applies: (ctx) => ["png", "jpeg", "webp", "tiff"].includes(ctx.node.kind.id),
  run(ctx: Ctx): AnalyzerResult {
    const b = ctx.node.bytes;
    const steps: Step[] = [];
    const flags: FlagHit[] = [];

    let data: ExifData | null = null;
    for (const off of findExifOffsets(b)) {
      const d = parseExif(b, off);
      if (d && d.tags.length) { data = d; break; }
    }
    if (!data) return { steps, derived: [], flags };

    // ── 1. 撮影情報の一覧 ──
    const listed = data.tags.filter((t) => !t.name.startsWith("GPS"));
    if (listed.length) {
      const id = ctx.nextId();
      const text = listed.map((t) => `${t.name}: ${fmt(t.value)}`).join("\n");
      flags.push(...findFlags(new TextEncoder().encode(text), ctx.flagPatterns, "EXIFタグ", ctx.node.path, id));
      steps.push({
        id, analyzer: "exif", genre: "osint",
        title: `EXIFに ${listed.length} 個のタグ`,
        observation: listed.map((t) => `${t.name}: ${fmt(t.value)}`).join(" / "),
        reasoning:
          "撮影機材・使用ソフト・日時・作者名は、画像の見た目には一切出ないが、ファイルには残る。" +
          "『いつ・何で・誰が』が分かるので、複数の情報を突き合わせれば人物や行動の推定に繋がる。" +
          "だからこそ、写真を公開する側は消しておくべき情報でもある。",
        action: "TIFF形式のタグ一覧を読み出した",
        command: "exiftool -a -u -g1 chal.png",
        outcome: `${listed.length} 個のタグを取得`,
        confidence: 0.7,
        learn:
          "EXIFはJPEGだけのものではない。PNGのeXIfチャンク、WebP、TIFF、HEICにも同じ形式で入る。" +
          "SNSにアップロードされた画像は多くの場合削除済みだが、元ファイルには残っている。",
      });
    }

    // ── 2. GPS座標 ──
    if (data.gps) {
      const g = data.gps;
      const latRaw = data.tags.find((t) => t.name === "GPSLatitude")?.raw ?? [];
      const lonRaw = data.tags.find((t) => t.name === "GPSLongitude")?.raw ?? [];
      steps.push({
        id: ctx.nextId(), analyzer: "exif", genre: "geo",
        title: "GPS座標が記録されている",
        // 観察と根拠はヒントとして出る。ここには「変換のしかた」までを書き、
        // 計算結果そのものは outcome に置く（ヒントで答えを渡さないため）
        observation:
          `緯度 ${formatDms(latRaw, g.latRef)}、経度 ${formatDms(lonRaw, g.lonRef)}（度・分・秒の表記）`,
        reasoning:
          "EXIFの座標は度分秒(DMS)で入っている。地図サービスは十進度を使うので、" +
          "度 + 分÷60 + 秒÷3600 で換算する。" +
          "間違えやすいのは符号で、参照方向が S（南緯）または W（西経）なら値を負にしなければならない。" +
          "もう一つの定番の誤りが緯度と経度の取り違えで、緯度は±90、経度は±180の範囲に収まるので、" +
          "90を超える値があればそれは経度だと判断できる。",
        action: "度分秒を十進度に換算し、参照方向から符号を決めた",
        command: "exiftool -gps:all -c '%.6f' chal.png",
        outcome: `十進度で ${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`,
        confidence: 0.9,
        learn:
          "座標が分かってもそれで終わりではない。周辺に何があるかを地図で確認し、" +
          "写真に写っているものと矛盾しないかを照合するところまでが確認作業。",
      });
    }

    return { steps, derived: [], flags };
  },
};

function fmt(v: string | number | number[]): string {
  if (Array.isArray(v)) return v.length > 8 ? `[${v.slice(0, 8).join(", ")}…]` : `[${v.join(", ")}]`;
  return String(v);
}
