/** DOM組み立ての小道具。textContentで入れるのでHTMLインジェクションの余地を作らない */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function defs(rows: [string, string][]): HTMLElement {
  const dl = el("dl", "row");
  for (const [k, v] of rows) {
    dl.append(el("dt", undefined, k), el("dd", undefined, v));
  }
  return dl;
}

export function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** バイト列をファイルとして保存させる */
export function download(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = el("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 即座に revoke するとSafariでダウンロードが始まらないことがある
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
