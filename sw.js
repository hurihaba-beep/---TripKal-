// Service Worker: מעדכן תמיד קודם מהרשת (network-first) לדף עצמו ולקבצי המניפסט,
// כדי שאתה תמיד תראה את הגרסה העדכנית ביותר כשיש אינטרנט. המטמון (cache) משמש רק
// כרשת ביטחון למקרה שאין חיבור בכלל (עבודה אופליין) - לא כמקור ברירת מחדל.

const CACHE_NAME = 'trip-planner-shell-v3';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

// קבצים "כבדים" שכמעט אף פעם לא משתנים - להם כן משתלם קודם מהמטמון (מהיר יותר, חוסך תעבורה)
const STATIC_LIBS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
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

  // בקשות API חיות (חיפוש מקומות, תרגום, OCR מ-CDN בזמן ריצה) - תמיד לרשת, אף פעם לא מהמטמון
  const isLiveApi = url.hostname.includes('nominatim.openstreetmap.org') ||
                     url.hostname.includes('api.anthropic.com') ||
                     url.hostname.includes('basemaps.cartocdn.com') ||
                     url.hostname.includes('tile.openstreetmap.org') ||
                     url.hostname.includes('translate.googleapis.com');

  if (isLiveApi) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // ספריות סטטיות כבדות (Leaflet וכו') - מטמון קודם, זה בסדר כי הן כמעט אף פעם לא משתנות
  const isStaticLib = STATIC_LIBS.some((host) => url.hostname.includes(host));
  if (isStaticLib) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // הדף עצמו (index.html), manifest.json וכו' - קודם רשת, כדי שתמיד תראו את הגרסה החדשה ביותר.
  // cache: 'no-store' מכריח את הדפדפן לפנות ממש לשרת, ולא "לשקר" עם תשובה שמורה במטמון ה-HTTP הרגיל.
  // רק אם אין בכלל אינטרנט, נופלים חזרה לגרסה השמורה במטמון של ה-Service Worker.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
