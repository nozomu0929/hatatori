/**
 * 種から決まる擬似乱数。
 * 同じ種なら必ず同じ問題が再現されるので、
 * 「昨日解いた問題をもう一度」も「不具合の再現」も種の共有だけで済む。
 */
export class RNG {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }

  /** xorshift32 */
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x;
  }
  int(maxExclusive: number): number { return this.next() % maxExclusive; }
  pick<T>(arr: readonly T[]): T { return arr[this.int(arr.length)]; }
  bytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
}

export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
}

const HEADS = ["hidden", "buried", "silent", "quiet", "deep", "lost", "faint", "cold", "sharp", "thin"];
const TAILS = ["signal", "marker", "channel", "anchor", "beacon", "cipher", "packet", "shadow", "vector", "index"];
const LEET: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", s: "5" };

/**
 * 問題ごとに異なるフラグを作る。
 * 固定フラグだと答えを検索・共有されて練習にならないため、
 * 生成のたびに変える。種から決まるので検証時は再現できる。
 */
export function makeFlag(rng: RNG, prefix = "flag", style: "lower" | "upper" = "lower"): string {
  const head = rng.pick(HEADS);
  const tail = rng.pick(TAILS);
  const leet = (w: string) => [...w].map((c) => (rng.int(3) === 0 && LEET[c]) || c).join("");
  const body = `${leet(head)}_${leet(tail)}_${rng.int(9000) + 1000}`;
  // 画像に描く問題では、大文字のみのビットマップフォントで表示するため字種を揃える
  return style === "upper" ? `FLAG{${body.toUpperCase()}}` : `${prefix}{${body}}`;
}
