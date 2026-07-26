// Service Worker פשוט - שומר "מעטפת אפליקציה" (הדף עצמו וספריית המפות) במטמון,
// כדי שהטופס עצמו (הוספת/מחיקת פריטים, חישוב תקציב) ימשיך לעבוד גם ללא אינטרנט.
// בקשות לשירותים חיצוניים חיים (חיפוש מפה, תרגום) תמיד יוצאות לרשת - אי אפשר וגם לא רצוי לשמור אותן במטמון.

const CACHE_NAME = 'trip-planner-shell-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // אם משאב כלשהו נכשל בטעינה, לא נופלים - הכלי ימשיך לעבוד עם מה שכן נשמר
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // בקשות API חיות (חיפוש מקומות, תרגום) - תמיד לרשת, אף פעם לא מהמטמון
  const isLiveApi = url.hostname.includes('nominatim.openstreetmap.org') ||
                     url.hostname.includes('api.anthropic.com') ||
                     url.hostname.includes('basemaps.cartocdn.com') ||
                     url.hostname.includes('tile.openstreetmap.org');

  if (isLiveApi) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // מעטפת האפליקציה - קודם מהמטמון (עובד אופליין), עם ניסיון רענון ברקע כשיש רשת
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
