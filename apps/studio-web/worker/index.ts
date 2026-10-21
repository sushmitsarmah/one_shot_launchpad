/**
 * Frontend Worker (root wrangler.jsonc). Static assets are served directly; only /t/* runs this code
 * (assets.run_worker_first) so token pages get per-token <head> tags in the served HTML for link-preview
 * crawlers that don't run JS. Reads the API's KV namespace (yeetpad-sites): slug:<slug> -> ticker,
 * site:<ticker> -> SiteConfig JSON. Dependency-free on purpose (bundled by wrangler, no build step).
 */
// Minimal Workers runtime types (keeps this file dependency-free).
interface El {
  setAttribute(n: string, v: string): void;
  setInnerContent(c: string): void;
  append(c: string, o?: { html: boolean }): void;
}
declare class HTMLRewriter {
  on(selector: string, handler: { element(el: El): void }): HTMLRewriter;
  transform(res: Response): Response;
}
interface KV {
  get(key: string): Promise<string | null>;
}
interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  SITES?: KV;
}
interface Site {
  slug?: string;
  branding: { name: string; ticker: string; tagline: string; description: string };
  theme: { colors: { primary: string; background: string } };
  iconDataUri?: string;
}

const ORIGIN = "https://yeetpad.fun";
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TICKER_RE = /^[a-z][a-z0-9]{1,15}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

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

/** Sets an attribute on matched elements; HTMLRewriter escapes attribute values itself. */
const attr = (name: string, value: string) => ({
  element(el: El) {
    el.setAttribute(name, value);
  },
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const id = decodeURIComponent(url.pathname.split("/")[2] ?? "").toLowerCase();
    if (!url.pathname.startsWith("/t/") || !id) return env.ASSETS.fetch(req);

    const page = await env.ASSETS.fetch(new Request(new URL("/t/", url), req));
    const found = ID_RE.test(id) && env.SITES ? await resolve(env.SITES, id).catch(() => null) : null;

    if (!found) {
      return new HTMLRewriter()
        .on("head", { element: (el) => void el.append('<meta name="robots" content="noindex">', { html: true }) })
        .transform(page);
    }
    const { site, ticker } = found;
    const slug = site.slug ?? ticker;
    if (id !== slug) return Response.redirect(`${url.origin}/t/${slug}${url.search}`, 301);

    const b = site.branding;
    const title = `${b.name} ($${b.ticker.toUpperCase()})`;
    const desc = (b.tagline ? `${b.tagline} ${b.description}` : b.description).slice(0, 300);
    const canonical = `${ORIGIN}/t/${slug}`;
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
    const res = rw.transform(page);
    const headers = new Headers(res.headers);
    headers.set("cache-control", "public, max-age=60");
    return new Response(res.body, { status: 200, headers });
  },
};
