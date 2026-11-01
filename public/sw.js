/**
 * BAメーカー PWA Service Worker (v22)
 * - アプリ本体(同一オリジン): Network-First（オンライン時は常に最新版を反映し、オフライン・電波不良時はキャッシュから即起動）
 * - AIぼかしモデル(MediaPipe WASM/モデル): Cache-First（2回目以降のAI起動を高速化）
 * - ライセンス認証API(workers.dev / /api/): キャッシュ対象外（常にリアルタイム認証）
 */
const SHELL_CACHE = "ba-maker-shell-v22";
const MODEL_CACHE = "ba-maker-ai-v1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./style.css?v=22",
  "./config.js?v=22",
  "./bgm.js?v=22",
  "./motion.js?v=22",
  "./face.js?v=22",
  "./app.js?v=22"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k.startsWith("ba-maker-shell-") && k !== SHELL_CACHE) {
            return caches.delete(k);
          }
          return Promise.resolve();
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (!req || req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // ライセンスAPI・Webhook・Stripe関連は一切キャッシュしない
  if (url.hostname.includes("workers.dev") || url.pathname.includes("/api/")) {
    return;
  }

  // MediaPipe WASM / AIモデルはバージョン固定のため Cache-First で高速化
  if (
    url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("@mediapipe/tasks-vision") ||
    url.hostname === "storage.googleapis.com" && url.pathname.includes("/mediapipe-models/")
  ) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const netRes = await fetch(req);
        if (netRes && netRes.ok) {
          cache.put(req, netRes.clone()).catch(() => {});
        }
        return netRes;
      }).catch(() => fetch(req))
    );
    return;
  }

  // 同一オリジンのアプリシェルは Network-First（更新即時反映＋オフライン起動フォールバック）
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((netRes) => {
          if (netRes && netRes.ok) {
            const copy = netRes.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return netRes;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          const exact = await cache.match(req);
          if (exact) return exact;
          const noQuery = await cache.match(url.pathname);
          if (noQuery) return noQuery;
          if (req.mode === "navigate") {
            return (await cache.match("./index.html")) || (await cache.match("./"));
          }
          throw new Error("offline");
        })
    );
  }
});
