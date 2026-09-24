/**
 * Flight Hunter — Node.js backend
 * =================================
 * Implements exactly the five endpoints the existing frontend already calls
 * against BACKEND_URL ("https://flight-hunter-api.onrender.com"):
 *
 *   GET  /api/search        origin, destination, date, adults, direct?, returnDate?
 *   GET  /api/live-price     origin, destination, date, returnDate?, adults
 *   GET  /api/places         query
 *   POST /api/search-multi   { legs:[{origin,destination,date}], adults }
 *   POST /api/subscribe      { username, email, origin, destination, date, budget, currency }
 *
 * Real data sources:
 *   - Duffel API        -> actual bookable-shaped flight offers (test or live token)
 *   - Travelpayouts      -> cached "cheap prices" used as a price-verification signal
 *   - Apify (optional)   -> live Google Flights / Kiwi scrape, for /api/live-price
 *   - Supabase           -> stores /api/subscribe signups
 *
 * NOTE on "scanning all dates": the frontend itself already loops over every
 * date it wants to check and calls /api/search once per date (see
 * mapWithConcurrency() in the frontend's runScan()). This backend does not
 * need its own multi-date scanning loop — one date in, one answer out, exactly
 * like the frontend already expects.
 *
 * Install:  npm install
 * Run:      cp .env.example .env   (then fill in real keys)
 *           npm start
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DUFFEL_TOKEN = process.env.DUFFEL_TOKEN || "";
const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

const TRAVELPAYOUTS_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

// ---- Anthropic (powers the on-demand "מה הכי כדאי?" AI summary button) ----
// console.anthropic.com -> create an API key. Not the same as a claude.ai
// login. Billed per request, which is exactly why this is wired to an
// on-demand button rather than firing automatically after every search.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

// ---------------------------------------------------------------------------
// Small in-memory cache: the frontend fans out up to 4 concurrent /api/search
// calls per scan (mapWithConcurrency, FETCH_CONCURRENCY=4) and re-checks
// saved "watches" roughly every minute — caching each (route+date) response
// for a few minutes avoids hammering Duffel/Travelpayouts with near-duplicate
// requests without needing a real database for this.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { expires, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

// ---------------------------------------------------------------------------
// Duffel helpers
// ---------------------------------------------------------------------------
async function duffelFetch(path, options = {}) {
  if (!DUFFEL_TOKEN) {
    const err = new Error("DUFFEL_TOKEN not configured");
    err.code = "no_token";
    throw err;
  }
  const res = await fetch(`${DUFFEL_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${DUFFEL_TOKEN}`,
      "Duffel-Version": DUFFEL_VERSION,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.errors?.[0]?.message || `Duffel HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.duffelErrors = data?.errors;
    throw err;
  }
  return data;
}

/**
 * Creates a Duffel offer request for one or two slices (one-way or round
 * trip) and returns the resulting list of offers (Duffel returns offers
 * embedded on the offer_request when return_offers=true).
 */
async function duffelSearch({ origin, destination, date, returnDate, adults }) {
  const slices = [{ origin, destination, departure_date: date }];
  if (returnDate) {
    slices.push({ origin: destination, destination: origin, departure_date: returnDate });
  }
  const passengers = Array.from({ length: adults }, () => ({ type: "adult" }));

  const body = {
    data: {
      slices,
      passengers,
      cabin_class: "economy",
    },
  };

  const result = await duffelFetch("/air/offer_requests?return_offers=true", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return result?.data?.offers || [];
}

function minutesBetween(a, b) {
  const diff = (new Date(b) - new Date(a)) / 60000;
  return isFinite(diff) ? Math.round(diff) : 0;
}

/** Converts a single Duffel offer into the flat shape the frontend expects. */
function mapDuffelOffer(offer) {
  const outboundSlice = offer.slices?.[0];
  const returnSlice = offer.slices?.[1] || null;
  if (!outboundSlice || !outboundSlice.segments?.length) return null;

  const segs = outboundSlice.segments;
  const firstSeg = segs[0];
  const lastSeg = segs[segs.length - 1];

  let maxLayoverMinutes = 0;
  for (let i = 1; i < segs.length; i++) {
    const gap = minutesBetween(segs[i - 1].arriving_at, segs[i].departing_at);
    if (gap > maxLayoverMinutes) maxLayoverMinutes = gap;
  }

  const base = {
    price: parseFloat(offer.total_amount),
    currency: offer.total_currency,
    airline: firstSeg.marketing_carrier?.name || firstSeg.operating_carrier?.name || "N/A",
    airlineIata: firstSeg.marketing_carrier?.iata_code || firstSeg.operating_carrier?.iata_code || null,
    flightNumber: `${firstSeg.marketing_carrier?.iata_code || ""}${firstSeg.marketing_carrier_flight_number || ""}`,
    departureTime: firstSeg.departing_at,
    arrivalTime: lastSeg.arriving_at,
    stops: segs.length - 1,
    maxLayoverMinutes,
    isRoundTrip: !!returnSlice,
  };

  if (returnSlice && returnSlice.segments?.length) {
    const rSegs = returnSlice.segments;
    const rFirst = rSegs[0];
    const rLast = rSegs[rSegs.length - 1];
    base.returnDepartureTime = rFirst.departing_at;
    base.returnArrivalTime = rLast.arriving_at;
    base.returnFlightNumber = `${rFirst.marketing_carrier?.iata_code || ""}${rFirst.marketing_carrier_flight_number || ""}`;
    base.returnStops = rSegs.length - 1;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Travelpayouts helper — cached "cheap prices" used as a verification signal
// ---------------------------------------------------------------------------
async function travelpayoutsCheapPrice({ origin, destination, date }) {
  if (!TRAVELPAYOUTS_TOKEN) return { status: "no_token" };

  const url = `https://api.travelpayouts.com/v1/prices/cheap?origin=${origin}&destination=${destination}&depart_date=${date}&token=${TRAVELPAYOUTS_TOKEN}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { status: "request_failed", error: err.message };
  }

  if (res.status === 401 || res.status === 403) return { status: "bad_token" };
  if (!res.ok) return { status: "http_error", httpStatus: res.status };

  const data = await res.json().catch(() => null);
  if (!data || data.success === false) {
    return { status: "api_error", error: data?.error || "unknown" };
  }

  const routeData = data.data?.[destination];
  if (!routeData) return { status: "no_data" };

  // routeData is keyed by month-of-departure in some Travelpayouts responses,
  // or directly by an array of fare entries in others — handle both shapes.
  const entries = Array.isArray(routeData) ? routeData : Object.values(routeData);
  const flat = entries.flatMap((e) => (Array.isArray(e) ? e : [e]));
  const match = flat.find((f) => f && f.depart_date === date) || flat[0];

  if (!match || typeof match.price !== "number") return { status: "no_data" };

  return {
    status: "ok",
    price: match.price,
    foundAt: match.found_at || null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------
app.get("/api/search", async (req, res) => {
  const { origin, destination, date, returnDate, adults, direct } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: "origin, destination, and date are required" });
  }
  const adultsCount = Math.max(1, parseInt(adults, 10) || 1);
  const cacheKey = `search:${origin}:${destination}:${date}:${returnDate || ""}:${adultsCount}:${direct || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  let offers = [];
  try {
    const rawOffers = await duffelSearch({
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      date,
      returnDate: returnDate || null,
      adults: adultsCount,
    });
    offers = rawOffers.map(mapDuffelOffer).filter(Boolean);
  } catch (err) {
    if (err.code === "no_token") {
      return res.status(503).json({ error: "DUFFEL_TOKEN not configured on the server" });
    }
    return res.status(502).json({ error: "Duffel search failed", details: err.message });
  }

  if (direct === "true") {
    offers = offers.filter((o) => o.stops === 0);
  }
  offers.sort((a, b) => a.price - b.price);
  offers = offers.slice(0, 30); // keep the response light; frontend only ever shows top ~8 anyway

  const travelpayoutsReference = await travelpayoutsCheapPrice({
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    date,
  });

  const payload = { offers, travelpayoutsReference };
  cacheSet(cacheKey, payload);
  res.json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/live-price
// Best-effort live check via an Apify actor (Google Flights / Kiwi scrape).
// Without APIFY_TOKEN + APIFY_ACTOR_ID configured, this honestly returns 503
// rather than a fake price — the frontend's button already handles that by
// just staying clickable for a retry.
// ---------------------------------------------------------------------------
app.get("/api/live-price", async (req, res) => {
  const { origin, destination, date, returnDate, adults } = req.query;
  if (!origin || !destination || !date) {
    return res.status(400).json({ error: "origin, destination, and date are required" });
  }
  if (!APIFY_TOKEN || !APIFY_ACTOR_ID) {
    return res.status(503).json({ status: "not_configured", error: "APIFY_TOKEN / APIFY_ACTOR_ID not set" });
  }

  const adultsCount = Math.max(1, parseInt(adults, 10) || 1);

  try {
    const runUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
    const runRes = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: origin.toUpperCase(),
        destination: destination.toUpperCase(),
        departDate: date,
        returnDate: returnDate || null,
        adults: adultsCount,
      }),
      // Apify runs can take a while — give it a generous timeout via AbortController
      signal: AbortSignal.timeout(60_000),
    });

    if (!runRes.ok) {
      return res.status(502).json({ status: "error", error: `Apify HTTP ${runRes.status}` });
    }
    const items = await runRes.json();
    const item = Array.isArray(items) ? items[0] : null;
    if (!item || typeof item.price !== "number") {
      return res.status(404).json({ status: "not_found" });
    }

    // Expected actor output shape (adapt to whatever actor you actually use):
    // { price, source, sourcesFound: ["google","kiwi",...], prices: {google, kiwi}, links: {kiwi} }
    return res.json({
      status: "ok",
      price: item.price,
      source: item.source || item.cheapestSource || "unknown",
      cheapestSource: item.cheapestSource || item.source || "unknown",
      sourcesFound: item.sourcesFound || [],
      prices: item.prices || {},
      links: item.links || {},
    });
  } catch (err) {
    return res.status(502).json({ status: "error", error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/places — worldwide airport/city autocomplete, via Duffel's own
// places suggestion endpoint (no separate geocoding service needed).
// ---------------------------------------------------------------------------
app.get("/api/places", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (query.length < 2) return res.json({ places: [] });

  const cacheKey = `places:${query.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await duffelFetch(`/places/suggestions?query=${encodeURIComponent(query)}`);
    const places = (data?.data || [])
      .filter((p) => p.iata_code)
      .map((p) => ({
        iataCode: p.iata_code,
        name: p.name,
        cityName: p.city_name || p.city?.name || p.name,
      }));
    const payload = { places };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    if (err.code === "no_token") {
      return res.status(503).json({ places: [], error: "DUFFEL_TOKEN not configured on the server" });
    }
    res.status(502).json({ places: [], error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/search-multi — chains one-way Duffel searches leg by leg and
// sums the cheapest offer of each. Not verified against Travelpayouts (the
// frontend already labels multi-city results as unverified for this reason).
// ---------------------------------------------------------------------------
app.post("/api/search-multi", async (req, res) => {
  const { legs, adults } = req.body || {};
  if (!Array.isArray(legs) || legs.length < 2) {
    return res.status(400).json({ error: "at least two legs are required" });
  }
  const adultsCount = Math.max(1, parseInt(adults, 10) || 1);

  const legResults = [];
  let totalPrice = 0;

  try {
    for (const leg of legs) {
      if (!leg.origin || !leg.destination || !leg.date) {
        return res.status(400).json({ error: "each leg needs origin, destination, and date" });
      }
      const rawOffers = await duffelSearch({
        origin: leg.origin.toUpperCase(),
        destination: leg.destination.toUpperCase(),
        date: leg.date,
        returnDate: null,
        adults: adultsCount,
      });
      const offers = rawOffers.map(mapDuffelOffer).filter(Boolean).sort((a, b) => a.price - b.price);
      if (offers.length === 0) {
        return res.json({ offers: [] }); // no itinerary possible if any leg has nothing
      }
      const cheapest = offers[0];
      totalPrice += cheapest.price;
      legResults.push({
        departureAirport: leg.origin.toUpperCase(),
        arrivalAirport: leg.destination.toUpperCase(),
        airline: cheapest.airline,
        flightNumber: cheapest.flightNumber,
        departureTime: cheapest.departureTime,
        stops: cheapest.stops,
      });
    }
  } catch (err) {
    if (err.code === "no_token") {
      return res.status(503).json({ error: "DUFFEL_TOKEN not configured on the server" });
    }
    return res.status(502).json({ error: "Duffel search failed", details: err.message });
  }

  res.json({
    offers: [{ price: Math.round(totalPrice), legs: legResults }],
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai-summary
// On-demand only (never called automatically after a search) — the frontend
// wires this to a "סכם לי מה הכי כדאי" button so it only costs money when
// someone actually asks for it. Takes the offers already fetched by
// /api/search (so this endpoint does no new flight searching itself, no
// extra Duffel/Travelpayouts calls) and asks Claude for a short Hebrew
// recommendation: cheapest verified option, best value trade-off
// (price vs. stops vs. baggage), and a flag if an unverified price looks
// implausibly low (possible pricing mistake / stale test data).
// ---------------------------------------------------------------------------
app.post('/api/ai-summary', async (req, res) => {
  const { origin, destination, currency, budget, offers, travelpayoutsReference } = req.body || {};

  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not configured on the server" });
  }
  if (!Array.isArray(offers) || offers.length === 0) {
    return res.status(400).json({ error: "offers array is required (pass the results from /api/search)" });
  }

  // Trim to what the model actually needs — keeps the request small/cheap
  // and avoids leaking anything beyond price/route shape.
  const compact = offers.slice(0, 15).map(o => ({
    price: o.price,
    currency: o.currency,
    airline: o.airline,
    stops: o.stops,
    departureTime: o.departureTime,
    isRoundTrip: !!o.isRoundTrip,
  }));

  const verifiedPrice = (travelpayoutsReference && travelpayoutsReference.status === 'ok')
    ? travelpayoutsReference.price
    : null;

  const userPrompt = `יעד: ${origin || 'TLV'} -> ${destination}
מטבע תצוגה: ${currency || 'USD'}
תקציב יעד (אם הוגדר): ${budget != null ? budget : 'לא הוגדר'}
מחיר מאומת (Travelpayouts/Aviasales, אם קיים): ${verifiedPrice != null ? verifiedPrice : 'אין נתון מאומת'}

הצעות טיסה (JSON, עד 15 הזולות ביותר):
${JSON.stringify(compact, null, 2)}

כתוב סיכום קצר בעברית (עד 4-5 משפטים, בלי כותרות, בלי רשימות): מה ההצעה הכי משתלמת ולמה (איזון בין מחיר, עצירות, האם הלוך-חזור), האם יש הבדל משמעותי בין המחיר המאומת למחירים האחרים שכדאי לשים לב אליו, ואיזו הצעה הכי הגיונית לבחור בפועל. אם מחיר נראה נמוך בצורה חריגה ולא מאומת, ציין זאת כאזהרה קלה ולא כעובדה.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await aiRes.json();
    if (!aiRes.ok) {
      return res.status(502).json({ error: 'Anthropic API error', details: data?.error?.message || data });
    }

    const summaryText = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!summaryText) {
      return res.status(502).json({ error: 'לא התקבל סיכום מהמודל' });
    }

    res.json({ status: 'ok', summary: summaryText });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscribe — persists to Supabase.
//
// Expected Supabase table (create once in the Supabase SQL editor):
//
//   create table subscribers (
//     id bigint generated always as identity primary key,
//     username text not null,
//     email text,
//     origin text,
//     destination text,
//     search_date date,
//     budget numeric,
//     currency text,
//     created_at timestamptz default now()
//   );
//
// The frontend's privacy note promises the email is deleted after 30 days.
// This server enforces that with a daily sweep (see bottom of file) rather
// than a Supabase-side cron job, since that keeps everything in one place —
// but note this only runs while the Node process is alive, so on a
// free-tier host that sleeps after inactivity, run this as a periodic
// scheduled job (e.g. Render Cron Job hitting a dedicated cleanup route)
// instead of relying on setInterval if that matters for your deployment.
// ---------------------------------------------------------------------------
app.post("/api/subscribe", async (req, res) => {
  const { username, email, origin, destination, date, budget, currency } = req.body || {};

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(503).json({ error: "Supabase not configured on the server" });
  }
  if (!username || !email || !destination || !date) {
    return res.status(400).json({ error: "username, email, destination, and date are required" });
  }

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify([{
        username,
        email,
        origin: origin || "TLV",
        destination,
        search_date: date,
        budget: budget || null,
        currency: currency || "ILS",
      }]),
    });

    if (!insertRes.ok) {
      const errBody = await insertRes.text().catch(() => "");
      return res.status(502).json({ error: "Supabase insert failed", details: errBody });
    }

    res.json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Daily sweep: null out emails older than 30 days, per the privacy notice
// shown on the page. See the comment above /api/subscribe for the caveat
// about this only running while the process stays alive.
// ---------------------------------------------------------------------------
async function cleanupOldEmails() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/subscribers?created_at=lt.${encodeURIComponent(cutoff)}&email=not.is.null`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ email: null }),
    });
  } catch (err) {
    console.error("cleanupOldEmails failed:", err.message);
  }
}
setInterval(cleanupOldEmails, 24 * 60 * 60 * 1000);
cleanupOldEmails();

// ---------------------------------------------------------------------------
app.get("/", (req, res) => res.json({ status: "ok", service: "flight-hunter-backend" }));

app.listen(PORT, () => {
  console.log(`Flight Hunter backend listening on port ${PORT}`);
  if (!DUFFEL_TOKEN) console.warn("⚠ DUFFEL_TOKEN not set — /api/search and /api/places will return 503");
  if (!TRAVELPAYOUTS_TOKEN) console.warn("⚠ TRAVELPAYOUTS_TOKEN not set — verification will always show 'no_token'");
  if (!APIFY_TOKEN || !APIFY_ACTOR_ID) console.warn("⚠ APIFY_TOKEN/APIFY_ACTOR_ID not set — /api/live-price will return 503");
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.warn("⚠ SUPABASE_URL/SUPABASE_SECRET_KEY not set — /api/subscribe will return 503");
  if (!ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY not set — /api/ai-summary will return 503");
});
