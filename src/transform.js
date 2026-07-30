// BOM Radar transform v4 — recipe-ready: config-driven, generic across stations.
//
// Config channels (first match wins, so this works whether or not TRMNL passes
// custom field values into the transform):
//   1. input.trmnl.plugin_settings.custom_fields_values.{radar_id, zoom_1, ...}
//   2. the rendered polling_url — radar/zoom are baked into the fetched page,
//      and home/site coords ride in its ?c=lat,lon,lat,lon query string.
//   3. hard fallback: Melbourne (Broadmeadows) IDR013 + IDR012, no pan.
//
// Design notes (correct by construction):
// - Product IDs are DISCOVERED from the polled page content (frame paths embed
//   them), never assumed — so a bad zoom choice for a station degrades to a
//   single-map view instead of breaking.
// - Range labels derive from BOM's suffix convention (1=512, 2=256, 3=128, 4=64 km).
// - Frame lists come from BOM's own pages; fixed-width UTC stamps mean
//   lexicographic max == newest. Times format in the TRMNL user's own timezone.
// - Pan: images span 2*range km; home offset in km -> % translate, shared by all
//   layers. Disabled (0,0) when coords are absent, invalid, or out of coverage.
// - background.png palette (measured): stroke lum .541, fills .838/.863;
//   views threshold it with brightness window (0.60, 0.92) — see markup.

const BASE = "https://reg.bom.gov.au";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FALLBACK_PRODUCTS = ["IDR013", "IDR012"];
const RANGE_BY_SUFFIX = { "1": 512, "2": 256, "3": 128, "4": 64 };

function num(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const n = parseFloat(String(v).trim());
  return isFinite(n) ? n : NaN;
}

function framesByProduct(text) {
  // Discover product IDs and their frames from page content.
  const out = {};
  const re = /\/radar\/(ID[A-Z]\d{3})\.T\.(\d{12})\.png/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    (out[m[1]] = out[m[1]] || new Set()).add(m[2]);
  }
  return out;
}

function formatLocal(stamp, tz) {
  const d = new Date(Date.UTC(
    +stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8),
    +stamp.slice(8, 10), +stamp.slice(10, 12)
  ));
  try {
    const time = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
    const date = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
    return { time: time.replace(/\s?(am|pm)/i, s => s.trim().toLowerCase()), date: date };
  } catch (e) {
    return { time: stamp.slice(8, 10) + ":" + stamp.slice(10, 12) + " UTC", date: stamp.slice(0, 8) };
  }
}

function panPercentages(range_km, home, site) {
  if ([home.lat, home.lon, site.lat, site.lon].some(v => !isFinite(v))) return { tx: 0, ty: 0, on: false };
  const midLatRad = ((home.lat + site.lat) / 2) * Math.PI / 180;
  const east_km = (home.lon - site.lon) * 111.32 * Math.cos(midLatRad);
  const south_km = (site.lat - home.lat) * 111.06;
  const span = 2 * range_km;
  let tx = -(east_km / span) * 100;
  let ty = -(south_km / span) * 100;
  if (Math.abs(tx) > 45 || Math.abs(ty) > 45) return { tx: 0, ty: 0, on: false };
  return { tx: Math.round(tx * 100) / 100, ty: Math.round(ty * 100) / 100, on: true };
}

function buildRadar(id, stampSet, tz, home, site) {
  const suffix = id.slice(-1);
  const range_km = RANGE_BY_SUFFIX[suffix] || 128;
  const frames = Array.from(stampSet).sort();
  const latest = frames[frames.length - 1];
  const t = formatLocal(latest, tz);
  const pan = panPercentages(range_km, home, site);
  const tp = BASE + "/products/radar_transparencies/" + id;
  return {
    id: id, label: range_km + " km", ok: true,
    frames_count: frames.length, frame_stamp: latest,
    frame_url: BASE + "/radar/" + id + ".T." + latest + ".png",
    bg_url: tp + ".background.png",
    water_url: tp + ".waterways.png",
    range_url: tp + ".range.png",
    tx: pan.tx, ty: pan.ty, show_home: pan.on,
    time: t.time, date: t.date, range_km: range_km
  };
}

async function run(input) {
  const t = (input && input.trmnl) || {};
  const cf = (t.plugin_settings && t.plugin_settings.custom_fields_values) || {};
  const purl = (t.plugin_settings && t.plugin_settings.polling_url) || "";
  const q = purl.match(/[?&]c=(-?[\d.]*),(-?[\d.]*),(-?[\d.]*),(-?[\d.]*)/) || [];
  const home = { lat: num(cf.home_lat) || num(q[1]), lon: num(cf.home_lon) || num(q[2]) };
  const site = { lat: num(cf.site_lat) || num(q[3]), lon: num(cf.site_lon) || num(q[4]) };
  const tz = (t.user && t.user.time_zone_iana) || "Australia/Melbourne";

  // Gather frames from every polled body, preserving IDX order (zoom_1 first).
  const keys = Object.keys(input || {}).filter(k => /^IDX_\d+$/.test(k)).sort();
  const products = [];      // ordered product ids
  const byProduct = {};     // id -> Set of stamps
  for (const k of keys) {
    const body = (input[k] && (input[k].data || input[k])) || "";
    const found = framesByProduct(typeof body === "string" ? body : JSON.stringify(body));
    for (const id of Object.keys(found)) {
      if (!byProduct[id]) { byProduct[id] = new Set(); products.push(id); }
      for (const s of found[id]) byProduct[id].add(s);
    }
  }

  // Fallback: config empty or pages carried no frames -> fetch Melbourne defaults.
  let via = "poll";
  if (products.length === 0) {
    via = "fallback-fetch";
    for (const id of FALLBACK_PRODUCTS) {
      try {
        const res = await fetch(BASE + "/products/" + id + ".loop.shtml",
                                { headers: { "User-Agent": UA, "Accept": "text/html" } });
        const found = framesByProduct(await res.text());
        for (const fid of Object.keys(found)) {
          if (!byProduct[fid]) { byProduct[fid] = new Set(); products.push(fid); }
          for (const s of found[fid]) byProduct[fid].add(s);
        }
      } catch (e) { /* keep going */ }
    }
  }

  if (products.length === 0) {
    const raw = JSON.stringify(input || {});
    const offline = /will be offline|undergoing (routine )?maintenance/i.test(raw);
    return {
      status: offline ? "offline" : "error",
      status_message: offline ? "Radar offline for maintenance" : "No radar frames found — check the Radar station setting",
      radars: [], fetched_via: via
    };
  }

  const radars = products.map(id => buildRadar(id, byProduct[id], tz, home, site));
  return {
    status: "ok",
    status_message: "",
    radars: radars,
    frame_time_local: radars[0].time,
    frame_date_local: radars[0].date,
    fetched_via: via
  };
}