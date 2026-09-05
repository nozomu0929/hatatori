import type { Analyzer, Ctx, AnalyzerResult, Derived, Step } from "../types.ts";
import { u32le, u16le, ascii, findAll, hx } from "../bytes.ts";
import { inflateRaw } from "../inflate.ts";

interface Entry { name: string; method: number; flags: number; compSize: number; uncompSize: number; localOffset: number; }

export const zip: Analyzer = {
  name: "zip",
  genre: "forensics",
  applies: (ctx) => ctx.node.kind.id === "zip",
  async run(ctx: Ctx): Promise<AnalyzerResult> {
    const b = ctx.node.bytes;
    const steps: Step[] = [];
    const derived: Derived[] = [];
    const entries = parseCentralDirectory(b);

    if (entries.length === 0) {
      steps.push({
        id: ctx.nextId(), analyzer: "zip", genre: "forensics",
        title: "ZIPの中央ディレクトリを読めなかった",
        observation: "PK\\x05\\x06(EOCD)またはPK\\x01\\x02が見つからない",
        reasoning: "ZIPは末尾の中央ディレクトリから読む形式。ここが壊れている場合、意図的な破損か、切り出し位置がずれている可能性がある。",
        action: "ローカルヘッダの直接走査に切り替える",
        command: "zipdetails chal.zip   /   unzip -l chal.zip",
        outcome: "解析続行不能",
        confidence: 0.5,
        learn: "壊れたZIPの修復も定番問題。ローカルヘッダ(PK\\x03\\x04)は各ファイルの直前にあるので、中央ディレクトリが消えても復元できる。",
      });
      return { steps, derived, flags: [] };
    }

    // 中央ディレクトリの末尾(EOCD)までがZIP本体。ここは埋め込み走査の対象外にする
    const eocds = findAll(b, [0x50, 0x4b, 0x05, 0x06], 8);
    if (eocds.length) ctx.claim(0, eocds[eocds.length - 1] + 22, "ZIP本体");

    const encrypted = entries.filter((e) => e.flags & 1);
    const sid = ctx.nextId();
    steps.push({
      id: sid, analyzer: "zip", genre: "forensics",
      title: `ZIP内に ${entries.length} 個のエントリ`,
      observation: entries.slice(0, 12).map((e) =>
        `${e.name} (${e.uncompSize}B, ${methodName(e.method)}${e.flags & 1 ? ", 暗号化" : ""})`).join(" / "),
      reasoning: "アーカイブは中身を1つずつ取り出して、それぞれ独立したファイルとして調べ直す。入れ子になった書庫は珍しくない。",
      action: "中央ディレクトリを解析し、各エントリを展開する",
      command: "unzip -l chal.zip && unzip chal.zip -d out/",
      outcome: `${entries.length} 件を列挙${encrypted.length ? `（うち ${encrypted.length} 件はパスワード保護）` : ""}`,
      confidence: 0.8,
    });

    if (encrypted.length) {
      steps.push({
        id: ctx.nextId(), analyzer: "zip", genre: "crypto",
        title: `${encrypted.length} 件がパスワード保護されている`,
        observation: `汎用フラグのbit0が立っている: ${encrypted.map((e) => e.name).join(", ")}`,
        reasoning:
          "ZIPの暗号化には旧来のZipCryptoとAES-256がある。ZipCryptoは既知平文攻撃(bkcrack)で" +
          "パスワード不要で破れることがあり、同じ書庫内に非暗号化ファイルが混在していると特に有利になる。",
        action: "辞書攻撃または既知平文攻撃の対象として記録",
        command: "zip2john chal.zip > h.txt && john h.txt   #  あるいは bkcrack -C chal.zip -c secret.txt -p known.bin",
        outcome: "要パスワード。自動解析はここで停止",
        confidence: 0.75,
        learn: "『暗号化されている＝お手上げ』ではない。まず暗号化方式を特定するのが定石で、ZipCryptoなら勝ち目がある。",
      });
    }

    for (const e of entries.slice(0, 30)) {
      if (e.flags & 1) continue;
      const data = await extract(b, e);
      if (!data) continue;
      derived.push({ label: `${e.name}`, bytes: data, fromStepId: sid, recurse: true });
    }
    return { steps, derived, flags: [] };
  },
};

function methodName(m: number): string {
  return m === 0 ? "無圧縮" : m === 8 ? "deflate" : m === 12 ? "bzip2" : m === 14 ? "LZMA" : `方式${m}`;
}

function parseCentralDirectory(b: Uint8Array): Entry[] {
  const eocds = findAll(b, [0x50, 0x4b, 0x05, 0x06], 8);
  if (eocds.length === 0) return [];
  const eocd = eocds[eocds.length - 1];
  let p = u32le(b, eocd + 16);
  const total = u16le(b, eocd + 10);
  const out: Entry[] = [];
  for (let i = 0; i < total && p + 46 <= b.length; i++) {
    if (u32le(b, p) !== 0x02014b50) break;
    const fnLen = u16le(b, p + 28), exLen = u16le(b, p + 30), cmLen = u16le(b, p + 32);
    out.push({
      flags: u16le(b, p + 8),
      method: u16le(b, p + 10),
      compSize: u32le(b, p + 20),
      uncompSize: u32le(b, p + 24),
      localOffset: u32le(b, p + 42),
      name: ascii(b, p + 46, fnLen),
    });
    p += 46 + fnLen + exLen + cmLen;
  }
  return out;
}

async function extract(b: Uint8Array, e: Entry): Promise<Uint8Array | null> {
  const p = e.localOffset;
  if (p + 30 > b.length || u32le(b, p) !== 0x04034b50) return null;
  const fnLen = u16le(b, p + 26), exLen = u16le(b, p + 28);
  const start = p + 30 + fnLen + exLen;
  const raw = b.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw);
  return null; // 未対応の圧縮方式
}
