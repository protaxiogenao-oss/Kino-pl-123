// Kino plugin: 123AV — v1.1.0
// Listings on 123av.com; HLS via embed /stream?id=HASH (not surrit).
// Covers are DVD jackets (portrait); poster+backdrop + prefer s500 for clearer Home art.

function log(...args) {
  try {
    kino.log(...args);
  } catch (_) {}
}

function baseUrl() {
  const m = String(kino.config.get("mirror") || "https://123av.com")
    .trim()
    .replace(/\/+$/, "");
  return m || "https://123av.com";
}

function lang() {
  const l = String(kino.config.get("lang") || "en").toLowerCase();
  if (l === "ja" || l === "zh" || l === "en") return l;
  return "en";
}

function preferredQuality() {
  const q = String(kino.config.get("quality") || "hls").toLowerCase();
  if (q === "1080" || q === "720" || q === "480" || q === "360") return q;
  return "hls";
}

function cleanText(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pagePath(suffix) {
  const L = lang();
  const s = String(suffix || "").replace(/^\/+/, "");
  return "/" + L + "/" + s;
}

/**
 * Prefer a landscape-friendly URL when possible.
 * 123AV only ships DVD covers (≈2:3). We still set poster+backdrop to the
 * best cover (s500) so Home does not show broken/mismatched thumbs.
 * Preview URLs are MP4 clips, not stills — never use them as poster.
 */
function toLandscapeThumb(url) {
  let u = String(url || "").trim();
  if (!u) return undefined;
  // Strip query noise; keep cache-buster optional
  // Prefer larger still: s360 → s500
  u = u.replace(/\/img2\/s360\//i, "/img2/s500/");
  // Never use preview MP4 path as image
  if (/\/preview\//i.test(u) && !/cover\.(jpg|jpeg|webp|png)/i.test(u)) {
    return undefined;
  }
  return u;
}

function toItem(v) {
  const thumb = toLandscapeThumb(v.thumb) || v.thumb || undefined;
  return {
    id: v.id,
    ref: v.id,
    title: v.title,
    kind: "movie",
    // poster + backdrop: same  cover so title page and cards share art
    poster: thumb,
    backdrop: thumb,
    quality: v.quality,
    overview: v.code || undefined,
    adult: true,
  };
}

/** /en/v/mfyd-204 or /en/v/fc2-ppv-123 */
function slugFromHref(href) {
  const h = String(href || "");
  const m = /\/(?:en|ja|zh)\/v\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/i.exec(h);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Parse listing cards. Prefer whole .card / .featured blocks so the
 * cover matches the video (href alone often picks a neighbour's image).
 */
function parseVideoCards(html) {
  const out = [];
  const seen = new Set();
  const src = String(html || "");

  // Split on card-like containers
  const blocks = [];
  const blockRe =
    /<div[^>]*class="[^"]*(?:card|featured)[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*(?:card|featured)[^"]*"|$)/gi;
  let bm;
  while ((bm = blockRe.exec(src))) {
    if (bm[0].length > 80) blocks.push(bm[0]);
  }

  const parseBlock = (block) => {
    const hrefM =
      /href="((?:https?:\/\/[^"]+)?\/(?:en|ja|zh)\/v\/([a-zA-Z0-9][a-zA-Z0-9._-]*))"/i.exec(
        block
      );
    if (!hrefM) return null;
    const id = hrefM[2].toLowerCase();
    if (seen.has(id)) return null;

    let title = "";
    const t1 =
      /<(?:h[12]|div|span)[^>]*class="[^"]*(?:title|featured__title|card__title)[^"]*"[^>]*>([^<]{1,160})</i.exec(
        block
      );
    if (t1) title = cleanText(t1[1]);
    if (!title) {
      const t2 = /title="([^"]{2,160})"/i.exec(block);
      if (t2) title = cleanText(t2[1]);
    }
    if (!title) title = id.toUpperCase();

    // Cover still only (not data-preview MP4)
    let thumb = "";
    const imgCover =
      /(?:data-src|src)="(https?:\/\/icdn\.[^"]+\/(?:img2\/s\d+\/)[^"]+cover\.(?:jpg|jpeg|webp|png)[^"]*)"/i.exec(
        block
      ) ||
      /(?:data-src|src)="(https?:\/\/icdn\.[^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i.exec(
        block
      );
    if (imgCover) thumb = imgCover[1];

    // If we only have preview path, derive cover from same hash folder
    if (!thumb) {
      const prev =
        /data-preview="(https?:\/\/icdn\.[^"]+\/preview\/([a-z0-9]+)\/([^"/?]+))/i.exec(
          block
        );
      if (prev) {
        thumb =
          "https://icdn.123av.me/img2/s500/" +
          prev[2] +
          "/" +
          prev[3] +
          "/cover.jpg";
      }
    }

    thumb = toLandscapeThumb(thumb) || thumb;

    let quality;
    if (/uncensored/i.test(id) || /uncensored/i.test(block)) {
      quality = "Uncensored";
    } else if (/\bhd\b/i.test(block)) {
      quality = "HD";
    }

    seen.add(id);
    return { id, title, thumb, quality, code: id.toUpperCase() };
  };

  for (const block of blocks) {
    const item = parseBlock(block);
    if (item) {
      out.push(item);
      if (out.length >= 80) return out;
    }
  }

  // Fallback: href scan (previous behaviour)
  if (out.length < 8) {
    const re =
      /href="((?:https?:\/\/[^"]+)?\/(?:en|ja|zh)\/v\/([a-zA-Z0-9][a-zA-Z0-9._-]*))"/gi;
    let m;
    while ((m = re.exec(src))) {
      const id = m[2].toLowerCase();
      if (seen.has(id)) continue;
      const start = Math.max(0, m.index - 500);
      const end = Math.min(src.length, m.index + 500);
      const ctx = src.slice(start, end);
      const item = parseBlock(ctx);
      if (item) {
        out.push(item);
        if (out.length >= 80) break;
      } else {
        seen.add(id);
        out.push({
          id,
          title: id.toUpperCase(),
          thumb: undefined,
          quality: /uncensored/i.test(id) ? "Uncensored" : undefined,
          code: id.toUpperCase(),
        });
      }
    }
  }

  return out;
}

async function fetchHtml(pathOrUrl) {
  const base = baseUrl();
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : base + (pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl);
  const r = await kino.fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: base + "/",
    },
    cookies: true,
    timeoutMs: 20000,
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const html = r.text();
  if (
    /just a moment|cf-browser-verification|challenge-platform/i.test(html) &&
    html.length < 14000
  ) {
    throw new Error("cloudflare");
  }
  return { html, url: r.url || url };
}

/** Decode player(JSON.parse('...')) episode list from watch page. */
function extractEmbeds(html) {
  const m = /player\(JSON\.parse\('([^']+)'\)/i.exec(html);
  if (!m) return [];
  let raw = m[1];
  try {
    // HTML attribute often has \u0022 and \/ escapes
    raw = raw.replace(/\\u0022/g, '"').replace(/\\u0027/g, "'");
    for (let i = 0; i < 5; i++) {
      if (raw.indexOf("\\/") >= 0 || raw.indexOf("\\\\/") >= 0) {
        raw = raw.replace(/\\\\/g, "\\").replace(/\\\//g, "/");
      } else break;
    }
    // Second pass if still double-escaped
    if (raw.indexOf("\\u0022") >= 0 || raw.indexOf("\\/") >= 0) {
      try {
        raw = JSON.parse('"' + m[1].replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
      } catch (_) {
        try {
          raw = m[1]
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16))
            )
            .replace(/\\\//g, "/");
        } catch (__) {}
      }
    }
    if (typeof raw !== "string") raw = String(raw);
    raw = raw.replace(/\\u0022/g, '"').replace(/\\\//g, "/");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .map((ep) => {
        let u = String((ep && ep.url) || "").split("?")[0];
        u = u.replace(/\\\//g, "/");
        return {
          name: String((ep && (ep.name || ep.number)) || "1"),
          url: u,
        };
      })
      .filter((e) => /^https?:\/\//i.test(e.url));
  } catch (e) {
    log("extractEmbeds", e.message || e);
    return [];
  }
}

/** hash id from https://host/e/HASH */
function embedHash(embedUrl) {
  const m = /\/e\/([a-zA-Z0-9_]+)/i.exec(embedUrl);
  return m ? m[1] : "";
}

/**
 * GET {embedOrigin}/stream?id=HASH → { media: { stream, vtt } }
 * Verified: returns m3u8 master (e.g. 1280x720 variants).
 */
async function fetchStreamFromEmbed(embedUrl) {
  const hash = embedHash(embedUrl);
  if (!hash) return null;
  let origin;
  try {
    origin = String(embedUrl).replace(/^(https?:\/\/[^/]+).*/i, "$1");
  } catch {
    return null;
  }
  const streamApi = origin + "/stream?id=" + encodeURIComponent(hash);
  const r = await kino.fetch(streamApi, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: embedUrl,
      Origin: origin,
    },
    cookies: true,
    timeoutMs: 15000,
  });
  if (!r.ok) {
    log("stream api", r.status, streamApi);
    return null;
  }
  let data;
  try {
    data = JSON.parse(r.text());
  } catch (e) {
    log("stream json", e.message || e);
    return null;
  }
  const stream = data && data.media && data.media.stream;
  if (!stream || !/^https?:\/\//i.test(stream)) return null;
  return {
    stream,
    vtt: data.media.vtt || undefined,
    origin,
    embedUrl,
  };
}

function streamHeaders(referer, origin) {
  const h = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer || origin || baseUrl() + "/",
  };
  if (origin) h.Origin = origin;
  return h;
}

function qualityHintUrl(masterUrl, pref) {
  if (!pref || pref === "hls") return masterUrl;
  return masterUrl;
}

// ---- search ----------------------------------------------------------------

export async function search(query) {
  const q = String(query.q || "").trim();
  if (!q) return [];

  const page = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  let path = pagePath("search") + "?keyword=" + encodeURIComponent(q);
  if (page > 0) path += "&page=" + (page + 1);

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("search", e.message || e);
    throw kino.error("unavailable", e.message || "búsqueda falló");
  }

  const cards = parseVideoCards(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 12 ? String(page + 1) : undefined;
  return next ? { items, next } : items;
}

// ---- home ------------------------------------------------------------------

export async function home() {
  const rows = [];
  const ROW_MAX = 60;
  const sections = [
    { id: "new", title: "Recientes / New", path: pagePath("new") },
    { id: "recent", title: "Recent update", path: pagePath("recent") },
    { id: "hot", title: "Hot", path: pagePath("hot") },
    {
      id: "uncensored-leaked",
      title: "Uncensored Leak",
      path: pagePath("uncensored-leaked"),
    },
    { id: "uncensored", title: "Uncensored", path: pagePath("uncensored") },
    { id: "censored", title: "Censored", path: pagePath("censored") },
    { id: "today", title: "Popular hoy", path: pagePath("all") + "?sort=today" },
    { id: "week", title: "Popular semana", path: pagePath("all") + "?sort=week" },
    { id: "month", title: "Popular mes", path: pagePath("all") + "?sort=month" },
    { id: "heyzo", title: "HEYZO", path: pagePath("makers/heyzo") },
    { id: "1pondo", title: "1pondo", path: pagePath("makers/1pondo") },
    {
      id: "caribbean",
      title: "Caribbeancom",
      path: pagePath("makers/caribbeancom"),
    },
    { id: "fc2", title: "FC2", path: pagePath("makers/fc2") },
  ];

  for (const sec of sections) {
    if (rows.length >= 20) break;
    try {
      const { html } = await fetchHtml(sec.path);
      const cards = parseVideoCards(html).slice(0, ROW_MAX);
      if (cards.length) {
        rows.push({
          id: sec.id,
          title: sec.title,
          items: cards.map(toItem),
          ref: sec.path.replace(/^\//, "").split("?")[0],
        });
      }
    } catch (e) {
      log("home", sec.id, e.message || e);
    }
  }

  if (!rows.length) {
    throw kino.error(
      "unavailable",
      "Sin listados (prueba mirror 1av.to en ajustes)"
    );
  }
  return rows;
}

// ---- browse ----------------------------------------------------------------

export async function browse(ref, cursor) {
  const page = cursor ? Math.max(0, Number(cursor) || 0) : 0;
  let path = String(ref || pagePath("new")).replace(/^\/+/, "");
  if (!/^https?:\/\//i.test(path) && path.indexOf("/") !== 0) {
    path = "/" + path;
  }
  if (!/^https?:\/\//i.test(path) && !/^\/(en|ja|zh)\//i.test(path)) {
    path = pagePath(path.replace(/^\//, ""));
  }
  if (page > 0) {
    path += (path.includes("?") ? "&" : "?") + "page=" + (page + 1);
  }

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("browse", e.message || e);
    throw kino.error("unavailable", e.message || "browse falló");
  }

  const cards = parseVideoCards(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 12 ? String(page + 1) : undefined;
  return { items, next };
}

// ---- resolve ---------------------------------------------------------------

export async function resolve(ref) {
  await Promise.resolve();

  let id = String(ref || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
  const fromPath = slugFromHref("/" + id) || slugFromHref(id);
  if (fromPath) id = fromPath;
  id = id.replace(/^v\//, "");
  id = id.replace(/[^a-z0-9._-]/g, "");
  if (!id) throw kino.error("not_found", "ref vacío");

  const L = lang();
  const base = baseUrl();
  const pageUrls = [
    base + "/" + L + "/v/" + id,
    base + "/en/v/" + id,
    base + "/ja/v/" + id,
  ];

  // Path A: browser.capture (helps if CDN is picky)
  const browserStream = await resolveViaBrowser(pageUrls);
  if (browserStream) return browserStream;

  // Path B: HTML → embed → /stream?id=
  let html = null;
  for (const url of pageUrls) {
    try {
      const r = await fetchHtml(url);
      html = r.html;
      if (extractEmbeds(html).length) break;
    } catch (e) {
      log("resolve page", url, e.message || e);
    }
  }
  if (!html) throw kino.error("not_found", "vídeo no encontrado");

  const embeds = extractEmbeds(html);
  if (!embeds.length) {
    throw kino.error(
      "unavailable",
      "sin embed de reproducción (¿captcha o cambio de plantilla?)"
    );
  }

  const pref = preferredQuality();
  const alternatives = [];
  let primary = null;

  for (let i = 0; i < embeds.length; i++) {
    const ep = embeds[i];
    try {
      const info = await fetchStreamFromEmbed(ep.url);
      if (!info || !info.stream) continue;
      const headers = streamHeaders(info.embedUrl, info.origin);
      const url = qualityHintUrl(info.stream, pref);
      const entry = {
        url,
        mime: "application/x-mpegURL",
        headers,
        label:
          embeds.length > 1
            ? "Parte " + ep.name
            : pref === "hls"
              ? "HLS"
              : pref + "p",
      };
      if (!primary) primary = entry;
      else alternatives.push(entry);
    } catch (e) {
      log("embed stream", ep.url, e.message || e);
    }
  }

  if (!primary) {
    throw kino.error("unavailable", "no se obtuvo el m3u8 del embed");
  }

  if (alternatives.length) primary.alternatives = alternatives;
  return primary;
}

async function resolveViaBrowser(pageUrls) {
  if (!kino.browser || typeof kino.browser.capture !== "function") return null;

  for (const pageUrl of pageUrls) {
    try {
      log("browser.capture", pageUrl);
      const opts = {
        timeoutMs: 22000,
        autoplay: true,
        match: "\\.m3u8|/stream|coolmindspace|strongpuremind|sadie-shop",
      };
      if (kino.browser.captureAll === true) {
        opts.captureAll = true;
        opts.alsoMatch = ["\\.m3u8", "/stream"];
      }
      const page = await kino.browser.capture(pageUrl, opts);
      const media = page.media || [];
      if (!media.length) continue;

      media.sort((a, b) => {
        const score = (u) =>
          (/\.m3u8/i.test(u) ? 3 : 0) + (/video\.m3u8/i.test(u) ? 2 : 0);
        return score(b.url) - score(a.url);
      });
      const primary = media[0];
      const headers = Object.assign({}, primary.headers || {});
      if (!headers.Referer && !headers.referer) {
        headers.Referer = page.finalUrl || pageUrl;
      }
      log("browser OK", primary.url.slice(0, 90));
      return {
        url: primary.url,
        mime: primary.mime || "application/x-mpegURL",
        headers,
        label: "Browser HLS",
        alternatives: media.slice(1, 6).map((m, i) => ({
          url: m.url,
          label: "alt " + (i + 1),
          headers: m.headers || headers,
          mime: m.mime || "application/x-mpegURL",
        })),
      };
    } catch (e) {
      const code = e && e.code;
      log("browser.capture error", code || "", e.message || e);
      if (code === "browser_unavailable" || code === "not_allowed") return null;
    }
  }
  return null;
}
