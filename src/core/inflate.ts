/** DEFLATE展開。Node/ブラウザ共通の標準API(DecompressionStream)のみ使用 */
export async function inflateRaw(b: Uint8Array): Promise<Uint8Array | null> {
  return decompress(b, "deflate-raw");
}
export async function gunzip(b: Uint8Array): Promise<Uint8Array | null> {
  return decompress(b, "gzip");
}
export async function inflateZlib(b: Uint8Array): Promise<Uint8Array | null> {
  return decompress(b, "deflate");
}

async function decompress(b: Uint8Array, format: string): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format as CompressionFormat);
    const stream = new Blob([b as BlobPart]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null; // 壊れたデータは呼び出し側で「展開できなかった」として扱う
  }
}
