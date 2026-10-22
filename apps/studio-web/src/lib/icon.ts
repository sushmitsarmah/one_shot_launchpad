import { tokenIconDataUri, type LaunchIdea } from "@osl/schema";

/** JustHoot stores the icon on-chain as a data URI of at most 7000 chars (their client uses a 128 px webp). */
export const JUSTHOOT_ICON_MAX = 7000;

/**
 * Rasterises Yeetpad's SVG token icon to a small webp, stepping size/quality down until it fits `max` chars.
 * Returns null if it can't fit (or the browser can't encode webp); the API then falls back to the SVG or no icon.
 */
export async function webpIcon(idea: Pick<LaunchIdea, "ticker" | "colors">, max = JUSTHOOT_ICON_MAX): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const img = new Image();
  img.src = tokenIconDataUri(idea);
  try {
    await img.decode();
  } catch {
    return null;
  }
  for (const px of [128, 96, 64]) {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, px, px);
    for (const q of [0.85, 0.7, 0.5, 0.3]) {
      const uri = c.toDataURL("image/webp", q);
      if (!uri.startsWith("data:image/webp")) return null; // no webp encoder (old Safari)
      if (uri.length <= max) return uri;
    }
  }
  return null;
}

export async function webpIcons(ideas: Pick<LaunchIdea, "ticker" | "colors">[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const i of ideas) {
    const w = await webpIcon(i);
    if (w) out[i.ticker] = w;
  }
  return out;
}
