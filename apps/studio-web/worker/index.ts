/**
 * Frontend Worker (root wrangler.jsonc). Static assets are served directly; only /t/* runs this code
 * (assets.run_worker_first) so token pages get per-token <head> tags in the served HTML for link-preview
 * crawlers that don't run JS. Reads the API's KV namespace (yeetpad-sites): slug:<slug> -> ticker,
 * site:<ticker> -> SiteConfig JSON. Dependency-free on purpose (bundled by wrangler, no build step).
 *
 * Also: injects the creator's own GA4 tag (strictly validated id) on their token page, and counts
 * first-party page views in KV (`views:<ticker>`, no cookies). The counter is a read-modify-write on
 * eventually consistent KV, so concurrent views can be lost and counts lag: approximate by design.
 */
// Minimal Workers runtime types (keeps this file dependency-free).
interface El {
  setAttribute(n: string, v: string): void;
  setInnerContent(c: string): void;
  append(c: string, o?: { html: boolean }): void;
  after(c: string, o?: { html: boolean }): void;
}
declare class HTMLRewriter {
  on(selector: string, handler: { element(el: El): void }): HTMLRewriter;
  transform(res: Response): Response;
}
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}
interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  SITES?: KV;
  /** Canonical origin for token pages (wrangler var); yeetpad.fun by default. */
  SITE_ORIGIN?: string;
}
interface Site {
  slug?: string;
  branding: { name: string; ticker: string; tagline: string; description: string };
  theme: { colors: { primary: string; background: string } };
  iconDataUri?: string;
  analytics?: { gaId?: string };
  /** Soft delete by the creator (or a moderator): the page answers 410 and no view is counted. */
  takenDown?: { at: number; by: string; byAdmin?: boolean };
}

const DEFAULT_ORIGIN = "https://yeetpad.fun";
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TICKER_RE = /^[a-z][a-z0-9]{1,15}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
/** GA4 measurement id; the only creator-supplied string ever placed in a <script>. Same as GA_ID_RE in @osl/schema. */
const GA_ID_RE = /^G-[A-Z0-9]{4,12}$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|twitter|curl|wget|python|httpclient|okhttp|headless|lighthouse|pingdom|uptime|monitor/i;

/** Counts a human page view (skips bots, prefetch/prerender, non-GET, missing UA). */
function shouldCount(req: Request): boolean {
  if (req.method !== "GET") return false;
  const h = req.headers;
  const ua = h.get("user-agent") ?? "";
  if (!ua || BOT_RE.test(ua)) return false;
  const purpose = `${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""} ${h.get("x-moz") ?? ""} ${h.get("x-purpose") ?? ""}`;
  if (/prefetch|prerender|preview/i.test(purpose)) return false;
  const dest = h.get("sec-fetch-dest");
  return !dest || dest === "document";
}

async function bumpViews(kv: KV, ticker: string) {
  const k = `views:${ticker}`;
  const n = Number(await kv.get(k)) || 0;
  await kv.put(k, String(n + 1));
}

const gtag = (id: string) =>
  `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
  `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`;

async function resolve(kv: KV, id: string): Promise<{ site: Site; ticker: string } | null> {
  let ticker = TICKER_RE.test(id) ? id : null;
  let raw = ticker ? await kv.get(`site:${ticker}`) : null;
  if (!raw) {
    ticker = await kv.get(`slug:${id}`);
    raw = ticker ? await kv.get(`site:${ticker}`) : null;
  }
  if (!raw || !ticker) return null;
  try {
    return { site: JSON.parse(raw) as Site, ticker };
  } catch {
    return null;
  }
}

/** Plain 410 for a taken-down token page (no token copy, no analytics, not indexed). */
export function goneResponse(byAdmin = false): Response {
  const msg = byAdmin ? "This token page was taken down by a moderator." : "This token page was taken down by its creator.";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Page taken down</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#222}main{max-width:32rem;padding:2rem;text-align:center}p{color:#555}</style>` +
    `</head><body><main><h1>Gone</h1><p>${msg}</p><p>The token itself still exists on the NEAR blockchain; this page no longer represents it.</p><p><a href="/">yeetpad.fun</a></p></main></body></html>`;
  return new Response(html, { status: 410, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-robots-tag": "noindex" } });
}

async function takedownOf(kv: KV, ticker: string): Promise<{ byAdmin?: boolean } | null> {
  const raw = await kv.get(`deleted:${ticker}`).catch(() => null);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    return t && typeof t.at === "number" ? t : null;
  } catch {
    return null;
  }
}

/** Sets an attribute on matched elements; HTMLRewriter escapes attribute values itself. */
const attr = (name: string, value: string) => ({
  element(el: El) {
    el.setAttribute(name, value);
  },
});

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const id = decodeURIComponent(url.pathname.split("/")[2] ?? "").toLowerCase();
    if (!url.pathname.startsWith("/t/") || !id) return env.ASSETS.fetch(req);

    const page = await env.ASSETS.fetch(new Request(new URL("/t/", url), req));
    const found = ID_RE.test(id) && env.SITES ? await resolve(env.SITES, id).catch(() => null) : null;

    if (!found) {
      // Chain-only tokens have no site record; the takedown lives in deleted:<ticker>.
      const td = env.SITES && TICKER_RE.test(id) ? await takedownOf(env.SITES, id) : null;
      if (td) return goneResponse(td.byAdmin);
      return new HTMLRewriter()
        .on("head", { element: (el) => void el.append('<meta name="robots" content="noindex">', { html: true }) })
        .transform(page);
    }
    const { site, ticker } = found;
    if (site.takenDown) return goneResponse(site.takenDown.byAdmin);
    const slug = site.slug ?? ticker;
    if (id !== slug) return Response.redirect(`${url.origin}/t/${slug}${url.search}`, 301);

    const b = site.branding;
    const title = `${b.name} ($${b.ticker.toUpperCase()})`;
    const desc = (b.tagline ? `${b.tagline} ${b.description}` : b.description).slice(0, 300);
    const canonical = `${(env.SITE_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "")}/t/${slug}`;
    const bg = COLOR_RE.test(site.theme?.colors?.background ?? "") ? site.theme.colors.background : "#1b1433";
    const icon = site.iconDataUri?.startsWith("data:image/svg+xml") ? site.iconDataUri : null;

    let rw = new HTMLRewriter()
      .on("title", { element: (el) => void el.setInnerContent(title) })
      .on('meta[name="description"]', attr("content", desc))
      .on('meta[name="theme-color"]', attr("content", bg))
      .on('link[rel="canonical"]', attr("href", canonical))
      .on('meta[property="og:title"]', attr("content", title))
      .on('meta[property="og:description"]', attr("content", desc))
      .on('meta[property="og:url"]', attr("content", canonical))
      .on('meta[name="twitter:card"]', attr("content", "summary"))
      .on('meta[name="twitter:title"]', attr("content", title))
      .on('meta[name="twitter:description"]', attr("content", desc));
    if (icon) rw = rw.on('link[rel="icon"]', attr("href", icon));
    const gaId = site.analytics?.gaId;
    if (gaId && GA_ID_RE.test(gaId)) {
      rw = rw
        .on("head", { element: (el) => void el.append(gtag(gaId), { html: true }) })
        .on("p.tk-made", {
          element: (el) => void el.after('<p class="wrap tk-made tk-ga">This page may use the creator\'s analytics.</p>', { html: true }),
        });
    }
    if (env.SITES && shouldCount(req)) ctx.waitUntil(bumpViews(env.SITES, ticker).catch(() => undefined));
    const res = rw.transform(page);
    const headers = new Headers(res.headers);
    headers.set("cache-control", "public, max-age=60");
    return new Response(res.body, { status: 200, headers });
  },
};
