/**
 * ELF（Linuxの実行ファイル形式）の構造解析。
 *
 * rev（リバースエンジニアリング）の第一歩は逆アセンブルではなく、
 * 「どこに何が置かれているか」を把握すること。
 * コードは.text、読み取り専用データは.rodata、と役割が分かれているので、
 * 探すべき場所は構造から絞り込める。
 */
import { ascii, startsWith } from "./bytes.ts";

export interface ElfSection {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  /** 実行可能属性(SHF_EXECINSTR)が立っているか */
  executable: boolean;
  writable: boolean;
}

export interface ElfInfo {
  class: 32 | 64;
  littleEndian: boolean;
  type: string;
  machine: string;
  entry: number;
  sections: ElfSection[];
  /** 動的リンクされているか（.interpの有無で判断） */
  dynamic: boolean;
}

export interface ElfFailure { error: string; }

const E_TYPE: Record<number, string> = {
  0: "NONE", 1: "再配置可能オブジェクト(REL)", 2: "実行ファイル(EXEC)",
  3: "共有オブジェクト/PIE(DYN)", 4: "コアダンプ(CORE)",
};
const E_MACHINE: Record<number, string> = {
  3: "x86 (i386)", 8: "MIPS", 20: "PowerPC", 40: "ARM",
  62: "x86-64", 183: "AArch64", 243: "RISC-V",
};
const SHT: Record<number, string> = {
  0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA",
  6: "DYNAMIC", 8: "NOBITS", 9: "REL", 11: "DYNSYM",
};
export const sectionTypeName = (t: number) => SHT[t] ?? `type${t}`;

const SHF_WRITE = 0x1, SHF_EXECINSTR = 0x4;

export function parseElf(b: Uint8Array): ElfInfo | ElfFailure {
  if (!startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return { error: "ELFマジックバイトがない" };
  const cls = b[4], data = b[5];
  if (cls !== 1 && cls !== 2) return { error: `不正なELFクラス: ${cls}` };
  const is64 = cls === 2;
  const le = data === 1;
  if (data !== 1 && data !== 2) return { error: `不正なエンディアン指定: ${data}` };

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => (o + 2 <= b.length ? dv.getUint16(o, le) : 0);
  const u32 = (o: number) => (o + 4 <= b.length ? dv.getUint32(o, le) : 0);
  // オフセットは実用上32bitに収まる。BigIntを持ち回らずNumberに落とす
  const uptr = (o: number) => {
    if (!is64) return u32(o);
    if (o + 8 > b.length) return 0;
    return Number(dv.getBigUint64(o, le));
  };

  const eType = u16(16);
  const eMachine = u16(18);
  const entry = uptr(24);
  const shoff = uptr(is64 ? 40 : 32);
  const shentsize = u16(is64 ? 58 : 46);
  const shnum = u16(is64 ? 60 : 48);
  const shstrndx = u16(is64 ? 62 : 50);

  const sections: ElfSection[] = [];
  if (shoff > 0 && shnum > 0 && shnum < 4096 && shoff + shnum * shentsize <= b.length) {
    // まずセクション名文字列表の位置を得る
    const strHdr = shoff + shstrndx * shentsize;
    const strOff = shstrndx < shnum ? uptr(strHdr + (is64 ? 24 : 16)) : 0;
    const strSize = shstrndx < shnum ? uptr(strHdr + (is64 ? 32 : 20)) : 0;

    for (let i = 0; i < shnum; i++) {
      const h = shoff + i * shentsize;
      const nameOff = u32(h);
      const flags = is64 ? uptr(h + 8) : u32(h + 8);
      sections.push({
        name: readStr(b, strOff, strSize, nameOff),
        type: u32(h + 4),
        flags,
        addr: uptr(h + (is64 ? 16 : 12)),
        offset: uptr(h + (is64 ? 24 : 16)),
        size: uptr(h + (is64 ? 32 : 20)),
        executable: (flags & SHF_EXECINSTR) !== 0,
        writable: (flags & SHF_WRITE) !== 0,
      });
    }
  }

  return {
    class: is64 ? 64 : 32,
    littleEndian: le,
    type: E_TYPE[eType] ?? `不明(${eType})`,
    machine: E_MACHINE[eMachine] ?? `不明(0x${eMachine.toString(16)})`,
    entry,
    sections,
    dynamic: sections.some((s) => s.name === ".interp" || s.name === ".dynamic"),
  };
}

function readStr(b: Uint8Array, tableOff: number, tableSize: number, off: number): string {
  if (!tableSize || tableOff + off >= b.length) return "";
  let end = tableOff + off;
  const limit = Math.min(b.length, tableOff + tableSize);
  while (end < limit && b[end] !== 0) end++;
  return ascii(b, tableOff + off, end - (tableOff + off));
}

export function isElf(r: ElfInfo | ElfFailure): r is ElfInfo {
  return (r as ElfInfo).sections !== undefined;
}

/** セクションの中身を切り出す。NOBITS(.bss)はファイル上に実体を持たない */
export function sectionBytes(b: Uint8Array, s: ElfSection): Uint8Array {
  if (s.type === 8 || s.offset + s.size > b.length) return new Uint8Array(0);
  return b.subarray(s.offset, s.offset + s.size);
}
