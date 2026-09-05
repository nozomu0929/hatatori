/**
 * オフライン対応。解析は端末内で完結するので、本来は通信が要らない。
 *
 * キャッシュの方針は資産の性質で分ける:
 *
 *   index.html …… ネットワーク優先。
 *     これを素朴にキャッシュ優先にすると、一度開いた人には
 *     古い index.html が返り続け、そこが参照する古いJSが読まれる。
 *     結果として、以後どれだけ配信しても修正が永久に届かなくなる（実際に起きた）。
 *
 *   assets/* …… キャッシュ優先。
 *     ファイル名にビルド時のハッシュが入っており、内容が変われば名前も変わる。
 *     同じ名前なら中身は同じなので、取りに行く必要がない。
 *
 *   その他 …… キャッシュを返しつつ裏で更新（stale-while-revalidate）。
 */
const CACHE = "hatatori-v3";
const PRECACHE = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icon.svg", "./favicon.svg", "./favicon-32.png", "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll は1つでも取得に失敗すると全体が拒否される。
      // するとインストールが完了せず skipWaiting に到達しないため、
      // 古いSWが居座り続け、以後どんな配信も利用者に届かなくなる
      // （実際に icon.svg の欠落1件でこれが起きた）。
      // 事前キャッシュはあくまで補助なので、個別に試みて失敗は黙って捨てる。
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (req, res) => {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  return res;
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 画面遷移（index.html の取得）は常に最新を取りに行く。
  // 通信できないときだけキャッシュに落とす。
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req)
        .then((res) => put(req, res))
        .catch(() => caches.match(req).then((hit) => hit ?? caches.match("./index.html"))),
    );
    return;
  }

  // ハッシュ付きの資産は内容が変われば名前も変わるので、あるものをそのまま使う
  if (url.pathname.includes("/assets/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req).then((res) => put(req, res))),
    );
    return;
  }

  // それ以外はキャッシュを即返しつつ、裏で更新しておく
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => put(req, res)).catch(() => hit);
      return hit ?? net;
    }),
  );
});
