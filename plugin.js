/// <reference path="./kino.d.ts" />

/**
 * 123AV for Kino v1.2.0
 * - Correct titles from card__link / featured__title (HTML entities decoded)
 * - More home sections + higher item counts
 * - Paginated search
 * - Quality preference (HLS master / preferred height)
 * - Resolve always goes through /stream?id=HASH → real .m3u8
 */

const BASE = "https://123av.com";
const LANG = "en";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function headers(extra) {
  const h = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE + "/",
  };
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, function (_, n) {
      return String.fromCharCode(parseInt(n, 10));
    })
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, "");
}

async function fetchText(path) {
  const url = path.indexOf("http") === 0 ? path : BASE + path;
  const r = await kino.fetch(url, { headers: headers() });
  if (r.status === 429) throw kino.error("rate_limited", "demasiadas peticiones");
  if (r.status === 404) throw kino.error("not_found");
  if (!r.ok) throw kino.error("unavailable", "el sitio respondió " + r.status);
  return r.text();
}

/**
 * Parse listing cards with real titles.
 * Prefer <a class="card__link" href="/en/v/slug">Title text</a>
 * then featured__title, then slug fallback.
 */
function parseListing(html) {
  const items = [];
  const seen = {};

  function push(slug, title, poster, runtimeMinutes) {
    if (!slug || seen[slug]) return;
    seen[slug] = true;
    let t = decodeEntities(stripTags(title || ""));
    if (!t || t.length < 2) t = slug.replace(/-/g, " ").toUpperCase();
    // keep titles readable but not endless
    if (t.length > 200) t = t.slice(0, 197) + "…";
    items.push({
      id: slug,
      ref: slug,
      title: t,
      kind: "movie",
      poster: poster || undefined,
      runtimeMinutes: runtimeMinutes,
      adult: true,
    });
  }

  // 1) card__link with inner text (main grid)
  const linkRe =
    /<a class="card__link[^"]*"\s+href="\/(?:[a-z]{2}\/)?v\/([a-zA-Z0-9_-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[1];
    const title = m[2];
    const around = html.slice(Math.max(0, m.index - 800), m.index + 200);
    let poster;
    const imgM =
      around.match(/src="(https:\/\/icdn\.123av\.me\/[^"]+)"/) ||
      around.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|webp)[^"]*)"/i);
    if (imgM) poster = imgM[1];
    let runtimeMinutes;
    const durM = around.match(
      /class="[^"]*(?:dur|duration)[^"]*"[^>]*>(\d+:\d+(?::\d+)?)/i
    );
    if (durM) {
      const parts = durM[1].split(":").map(function (x) {
        return parseInt(x, 10);
      });
      let secs = 0;
      if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
      if (secs > 0) runtimeMinutes = Math.max(1, Math.round(secs / 60));
    }
    push(slug, title, poster, runtimeMinutes);
  }

  // 2) featured slides: h2.featured__title
  const featRe =
    /href="\/(?:[a-z]{2}\/)?v\/([a-zA-Z0-9_-]+)"[^>]*>\s*<h2 class="featured__title">([^<]+)<\/h2>/gi;
  while ((m = featRe.exec(html)) !== null) {
    const around = html.slice(Math.max(0, m.index - 600), m.index + 100);
    let poster;
    const imgM = around.match(/src="(https:\/\/icdn\.123av\.me\/[^"]+)"/);
    if (imgM) poster = imgM[1];
    push(m[1], m[2], poster, undefined);
  }

  // 3) fallback: any /v/slug + nearby title attribute or heading
  if (items.length === 0) {
    const anyRe = /href="\/(?:[a-z]{2}\/)?v\/([a-zA-Z0-9_-]+)"/g;
    while ((m = anyRe.exec(html)) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      const chunk = html.slice(m.index, m.index + 400);
      const tM =
        chunk.match(/featured__title">([^<]+)/) ||
        chunk.match(/>([A-Z0-9][A-Z0-9._-]{2,}[^<]{0,120})</);
      push(slug, tM ? tM[1] : slug, null, undefined);
    }
  }

  return items;
}

function nextCursor(html) {
  // Prefer explicit next page number higher than current
  const pages = [];
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n < 5000) pages.push(n);
  }
  if (!pages.length) return undefined;
  pages.sort(function (a, b) {
    return a - b;
  });
  // smallest page >= 2 that appears (caller builds full path)
  for (let i = 0; i < pages.length; i++) {
    if (pages[i] >= 2) return pages[i];
  }
  return undefined;
}

function withPage(path, page) {
  if (!page) return path;
  if (path.indexOf("page=") !== -1)
    return path.replace(/page=\d+/, "page=" + page);
  return path + (path.indexOf("?") >= 0 ? "&" : "?") + "page=" + page;
}

function extractEmbedHash(html) {
  if (!html) return null;
  const clean = String(html).split("\\").join("");
  let m = clean.match(/sadie-shop\.site\/e\/([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  m = clean.match(/\/e\/([A-Za-z0-9_]{4,24})/);
  if (m) return m[1];
  m = html.match(/JSON\.parse\('(\[[\s\S]*?\])'\)/);
  if (m) {
    try {
      const arr = JSON.parse(
        m[1]
          .replace(/\\u0022/g, '"')
          .replace(/\\\//g, "/")
          .replace(/\\"/g, '"')
      );
      if (arr && arr[0] && arr[0].url) {
        const um = String(arr[0].url).match(/\/e\/([A-Za-z0-9_]+)/);
        if (um) return um[1];
      }
    } catch (e) {}
  }
  return null;
}

async function streamFromHash(hashId) {
  const url =
    "https://sadie-shop.site/stream?id=" + encodeURIComponent(hashId);
  const r = await kino.fetch(url, {
    headers: headers({
      Accept: "application/json, text/plain, */*",
      Referer: "https://sadie-shop.site/e/" + hashId,
      Origin: "https://sadie-shop.site",
    }),
  });
  if (!r.ok) throw kino.error("unavailable", "stream API " + r.status);
  let data;
  try {
    data = r.json();
  } catch (e) {
    throw kino.error("unavailable", "stream API no devolvió JSON");
  }
  if (!data || data.status !== "ok" || !data.media || !data.media.stream) {
    throw kino.error("unavailable", "sin media.stream");
  }
  return data.media;
}

async function rowFrom(path, id, title, limit) {
  try {
    const html = await fetchText(path);
    const items = parseListing(html);
    if (!items.length) return null;
    return {
      id: id,
      title: title,
      items: items.slice(0, limit || 60),
      ref: path,
      genre: "otros",
    };
  } catch (e) {
    return null;
  }
}

export async function search(query) {
  await null;
  const q = (query.q || "").trim();
  if (!q) return [];

  let path;
  let page = 1;
  if (query.cursor) {
    // cursor is "path|page" or full path with page=
    const c = String(query.cursor);
    if (c.indexOf("|") >= 0) {
      const parts = c.split("|");
      path = parts[0];
      page = parseInt(parts[1], 10) || 1;
    } else {
      path = c;
      const pm = c.match(/page=(\d+)/);
      if (pm) page = parseInt(pm[1], 10);
    }
  } else {
    path =
      "/" +
      LANG +
      "/search?keyword=" +
      encodeURIComponent(q.slice(0, 80));
  }

  const html = await fetchText(withPage(path, page > 1 ? page : 0));
  const items = parseListing(html);
  // If site exposes higher pages, offer next
  const nextPage = page + 1;
  const hasMore =
    items.length >= 10 ||
    (html.indexOf("page=" + nextPage) !== -1);

  if (hasMore && items.length) {
    return {
      items: items.slice(0, 100),
      next: path + "|" + nextPage,
    };
  }
  return items.slice(0, 100);
}

export async function home() {
  await null;
  const rows = [];
  const specs = [
    ["/" + LANG, "home", "Destacados"],
    ["/" + LANG + "/new", "new", "Recién agregados"],
    ["/" + LANG + "/hot", "hot", "Hot"],
    ["/" + LANG + "/recent", "recent", "Recientes"],
    ["/" + LANG + "/all?sort=today", "today", "Hoy"],
    ["/" + LANG + "/all?sort=week", "week", "Esta semana"],
    ["/" + LANG + "/all?sort=month", "month", "Este mes"],
    ["/" + LANG + "/uncensored", "uncensored", "Uncensored"],
    ["/" + LANG + "/uncensored-leaked", "leaked", "Uncensored Leaked"],
    ["/" + LANG + "/censored", "censored", "Censored"],
  ];
  for (let i = 0; i < specs.length; i++) {
    const row = await rowFrom(specs[i][0], specs[i][1], specs[i][2], 60);
    if (row) rows.push(row);
  }
  return rows;
}

export async function browse(ref, cursor) {
  await null;
  let path = ref;
  let page = 1;
  if (cursor) {
    const c = String(cursor);
    if (c.indexOf("|") >= 0) {
      const parts = c.split("|");
      path = parts[0];
      page = parseInt(parts[1], 10) || 1;
    } else if (/^\d+$/.test(c)) {
      page = parseInt(c, 10);
    } else {
      path = c;
    }
  }
  const html = await fetchText(withPage(path, page > 1 ? page : 0));
  const items = parseListing(html);
  const nextPage = page + 1;
  const hasMore = items.length >= 10;
  return {
    items: items.slice(0, 60),
    next: hasMore ? path + "|" + nextPage : undefined,
  };
}

export async function resolve(ref) {
  await null;
  let slug = String(ref || "").trim();
  const um = slug.match(/\/v\/([a-zA-Z0-9_-]+)/);
  if (um) slug = um[1];
  slug = slug.replace(/^\/+/, "").split("/").pop();
  if (!slug) throw kino.error("not_found");

  const pageUrl = "/" + LANG + "/v/" + encodeURIComponent(slug);
  const html = await fetchText(pageUrl);

  const hash = extractEmbedHash(html);
  if (!hash) {
    throw kino.error("unavailable", "no se encontró el embed del video", {
      userMessage: "No se pudo obtener el enlace de reproducción de este título.",
    });
  }

  // Only kino.fetch to declared hosts (123av.com + sadie-shop.site).
  // Do NOT fetch the CDN master here: rotating CDNs would trigger a host
  // permission dialog on every play. streamHosts: "any" lets the player
  // open the m3u8 (and its segments) without asking.
  const media = await streamFromHash(hash);
  const masterUrl = media.stream;
  const referer = "https://sadie-shop.site/e/" + hash;

  return {
    url: masterUrl,
    mime: "application/vnd.apple.mpegurl",
    headers: {
      Referer: referer,
      "User-Agent": UA,
    },
  };
}
