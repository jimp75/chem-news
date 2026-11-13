// Chemical Sector Monitor: collects news on Cloudflare and serves it to the page.
// Runs on its own: no Claude, no Firecrawl and no API keys are needed for the news.

import PAGE from "./page.html";

const NOISE = /stock (price|forecast)|price target|shares (of|bought|sold)|zacks|market size|cagr|dow jones|institutional investor/i;
const SECTIONS = [
  { id: "latest", q: '"chemical industry" OR "chemical sector" OR "chemical maker"' },
  { id: "dow", q: '"Dow Inc" OR "Dow Chemical" OR "Dow" chemical -"Dow Jones"', must: /\bdow\b/i },
  { id: "henkel", q: "Henkel adhesive OR Henkel chemical", must: /henkel/i },
  { id: "wacker", q: '"Wacker Chemie" OR "Wacker Chemical"', must: /wacker/i },
  { id: "momentive", q: '"Momentive Performance Materials" OR "Momentive silicones"', must: /momentive/i },
  { id: "basf", q: "BASF chemical", must: /basf/i },
  { id: "evonik", q: "Evonik", must: /evonik/i },
  { id: "shinetsu", q: '"Shin-Etsu Chemical"', must: /shin.?etsu/i },
  { id: "otto", q: '"OTTO-CHEMIE" OR "Otto Chemie"', must: /otto.?chemie/i },
  { id: "huntsman", q: '"Huntsman Corporation" OR Huntsman chemical', must: /huntsman/i },
  { id: "molykote", q: "Molykote", must: /molykote/i },
  { id: "biesterfeld", q: "Biesterfeld distribution", must: /biesterfeld/i },
  { id: "bodomoller", q: '"Bodo Möller Chemie"', must: /bodo m/i },
  { id: "ellsworth", q: '"Ellsworth Adhesives"', must: /ellsworth/i },
  { id: "krayden", q: "Krayden adhesives", must: /krayden,? inc|krayden.*(adhesive|sealant|distribut|chemical)|(adhesive|sealant|distribut|chemical).*krayden/i }
];
const REFRESH_GAP = 10 * 60 * 1000; // one section refreshes at most every 10 minutes
const MAX_AGE = 60 * 24 * 60 * 60 * 1000; // ignore articles older than 60 days
const HEADERS = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "application/rss+xml, application/xml, text/xml, */*", "accept-language": "en-US,en;q=0.9" };
const CRON_BATCH = 20;              // stays inside Cloudflare's free-plan request limit

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS news (section TEXT PRIMARY KEY, items TEXT NOT NULL, updated INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, note TEXT NOT NULL, cat TEXT NOT NULL, created INTEGER NOT NULL)")
  ]);
  ready = true;
}

const decode = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(lt|gt|quot|apos|amp|nbsp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " }[e]))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]).trim() : ""; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateLabel = t => { const d = new Date(t); return !t || isNaN(d) ? "" : d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + (d.getUTCFullYear() === new Date().getUTCFullYear() ? "" : " " + d.getUTCFullYear()); };

export function parseFeed(xml, section) {
  const seen = new Set(), out = [];
  for (const [item] of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    let title = tag(item, "title"), source = tag(item, "source") || tag(item, "News:Source");
    let url = tag(item, "link");
    try { const real = new URL(url).searchParams.get("url"); if (/^https?:\/\//.test(real || "")) url = real; } catch (_) {}
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    else if (!source) { const m = title.match(/^(.*) - ([^-]{2,50})$/); if (m) { title = m[1]; source = m[2]; } }
    const text = title + " " + source, key = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!title || !/^https?:\/\//.test(url) || seen.has(key)) continue;
    if (NOISE.test(title) || (section.must && !section.must.test(text))) continue;
    const time = Date.parse(tag(item, "pubDate")) || 0;
    if (time && Date.now() - time > MAX_AGE) continue;
    seen.add(key);
    const note = tag(item, "description");
    out.push({ title, url, source, date: dateLabel(time), summary: /[<>]/.test(note) ? "" : note.slice(0, 220), time });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, section.id === "latest" ? 10 : 6).map(({ time, ...x }) => x);
}

async function feed(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error("feed " + res.status);
  return res.text();
}

function feedUrls(env, section) {
  const q = section.q + " when:30d";
  return env.FEED_BASE
    ? [`${env.FEED_BASE}/google?q=${encodeURIComponent(q)}`, `${env.FEED_BASE}/bing?q=${encodeURIComponent(section.q)}`]
    : [`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, `https://www.bing.com/news/search?q=${encodeURIComponent(section.q)}&format=rss`];
}

async function collect(env, section) {
  for (const url of feedUrls(env, section)) {
    try {
      const items = parseFeed(await feed(url), section);
      if (items.length) return items;
    } catch (e) { console.log("news source failed", section.id, String(e)); }
  }
  return [];
}

async function allSections(env) {
  const { results } = await env.DB.prepare("SELECT id, name FROM companies").all();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return SECTIONS.concat(results.map(c => ({ id: c.id, q: `"${c.name.replace(/"/g, "")}"`, must: new RegExp(esc(c.name), "i") })));
}

async function refresh(env, section) {
  const items = await collect(env, section), now = Date.now();
  if (items.length) await env.DB.prepare("INSERT OR REPLACE INTO news (section, items, updated) VALUES (?, ?, ?)").bind(section.id, JSON.stringify(items), now).run();
  else await env.DB.prepare("INSERT INTO news (section, items, updated) VALUES (?, '[]', ?) ON CONFLICT(section) DO UPDATE SET updated = excluded.updated").bind(section.id, now).run();
}

async function snapshot(env) {
  const [news, companies] = await Promise.all([
    env.DB.prepare("SELECT section, items, updated FROM news").all(),
    env.DB.prepare("SELECT id, name, url, note, cat FROM companies ORDER BY created").all()
  ]);
  const sections = {}; let updated = 0;
  for (const r of news.results) { const items = JSON.parse(r.items); sections[r.section] = items; if (items.length) updated = Math.max(updated, r.updated); }
  return { updated, sections, companies: companies.results };
}

async function digest(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)))); }
async function passwordOk(env, given) {
  if (!env.ADMIN_PASSWORD || !given) return false;
  const [a, b] = await Promise.all([digest(env.ADMIN_PASSWORD), digest(given)]);
  return a.every((v, i) => v === b[i]);
}
const CATS = ["manufacturers", "distributors"];
function cleanCompany(b) {
  const name = String(b.name || "").trim().slice(0, 60), note = String(b.note || "").trim().slice(0, 40);
  let url = String(b.url || "").trim().slice(0, 200);
  if (!name) return { error: "Enter a company name." };
  if (!CATS.includes(b.cat)) return { error: "Choose a menu." };
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try { if (!new URL(url).hostname.includes(".")) throw 0; } catch (_) { return { error: "Enter a valid website, or leave it empty." }; }
  }
  const slug = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
  return { id: "my-" + slug, name, url, note, cat: b.cat };
}

async function api(request, env, url) {
  await init(env);
  const path = url.pathname, method = request.method;
  if (path === "/api/news" && method === "GET") return json(await snapshot(env));
  if (path === "/api/status" && method === "GET") {
    const checks = [];
    for (const section of [SECTIONS[0], SECTIONS.find(s => s.id === "evonik")]) for (const u of feedUrls(env, section)) {
      const row = { section: section.id, source: new URL(u).hostname };
      try {
        const res = await fetch(u, { headers: HEADERS }), text = await res.text();
        Object.assign(row, { status: res.status, type: res.headers.get("content-type"), bytes: text.length, raw: (text.match(/<item\b/gi) || []).length, kept: parseFeed(text, section).length, start: text.slice(0, 120) });
      } catch (e) { row.error = String(e); }
      checks.push(row);
    }
    return json({ checks });
  }
  if (path === "/api/refresh" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const list = await allSections(env);
    const section = list.find(s => s.id === body.view) || list[0];
    const row = await env.DB.prepare("SELECT updated FROM news WHERE section = ?").bind(section.id).first();
    if (!row || Date.now() - row.updated > REFRESH_GAP) await refresh(env, section);
    return json(await snapshot(env));
  }
  if (path === "/api/companies" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD) return json({ error: "The admin password has not been set up yet." }, 503);
    if (!(await passwordOk(env, body.password))) return json({ error: "That password is not correct." }, 403);
    const c = cleanCompany(body);
    if (c.error) return json(c, 400);
    if (SECTIONS.some(s => s.id === c.id.slice(3)) || await env.DB.prepare("SELECT 1 FROM companies WHERE id = ?").bind(c.id).first()) return json({ error: c.name + " is already in the menus." }, 409);
    await env.DB.prepare("INSERT INTO companies (id, name, url, note, cat, created) VALUES (?, ?, ?, ?, ?, ?)").bind(c.id, c.name, c.url, c.note, c.cat, Date.now()).run();
    await refresh(env, { id: c.id, q: `"${c.name.replace(/"/g, "")}"`, must: new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
    return json({ id: c.id, ...(await snapshot(env)) });
  }
  const del = path.match(/^\/api\/companies\/(my-[a-z0-9-]+)$/);
  if (del && method === "DELETE") {
    if (!(await passwordOk(env, request.headers.get("x-admin-password")))) return json({ error: "That password is not correct." }, 403);
    await env.DB.batch([env.DB.prepare("DELETE FROM companies WHERE id = ?").bind(del[1]), env.DB.prepare("DELETE FROM news WHERE section = ?").bind(del[1])]);
    return json(await snapshot(env));
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/") return Response.redirect(url.origin + "/", 302);
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    try { return await api(request, env, url); }
    catch (e) { console.log("request failed", String(e)); return json({ error: "Something went wrong. Try again." }, 500); }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await init(env);
      const list = await allSections(env);
      const { results } = await env.DB.prepare("SELECT section, updated FROM news").all();
      const age = Object.fromEntries(results.map(r => [r.section, r.updated]));
      const due = list.sort((a, b) => (age[a.id] || 0) - (age[b.id] || 0)).slice(0, CRON_BATCH);
      for (const s of due) await refresh(env, s);
    })());
  }
};
