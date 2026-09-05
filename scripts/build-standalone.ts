/**
 * 単一HTMLファイルを作る。
 *
 * CSSとJSを本体に埋め込み、外部ファイルへの参照を無くす。
 * ホスティング先を選ばず、1ファイル置くだけで動く形にするため。
 *
 * なお Service Worker とマニフェストは外部ファイルが前提なので、
 * この形態ではPWAとしてのインストールはできない（解析機能は全て動く）。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const assets = dist + "assets/";
const files = readdirSync(assets);

const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(assets + f, "utf8")).join("\n");
const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(assets + f, "utf8")).join("\n");
if (!js) throw new Error("dist/assets にJSが無い。先に vite build を実行すること");

const html = readFileSync(dist + "index.html", "utf8");
// <body> の中身だけを取り出す（配布先が独自の外枠を付けるため）
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).trim()
  .replace(/<script[^>]*src=[^>]*><\/script>/g, "")
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");

const icon = readFileSync(fileURLToPath(new URL("../public/favicon.svg", import.meta.url)), "utf8");
const iconUrl = "data:image/svg+xml;base64," + Buffer.from(icon).toString("base64");

// 文字コードは必ずファイル自身に持たせる。
// 配信側がUTF-8を明示してくれる保証は無く、宣言が無いと windows-1252 と推測され
// 日本語が全て文字化けする（実際にそうなった）。
// HTMLの符号化推測は先頭1024バイトを走査するので、必ず先頭に置くこと。
const out = `<meta charset="utf-8">
<title>ハタトリ</title>
<link rel="icon" href="${iconUrl}" type="image/svg+xml">
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;

const target = fileURLToPath(new URL("../dist/hatatori.html", import.meta.url));
writeFileSync(target, out);
console.log(`単一HTML: dist/hatatori.html (${(out.length / 1024).toFixed(0)} KB)`);
