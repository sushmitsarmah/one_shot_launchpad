import type { LaunchIdea } from "./index";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * NEP-148 token icon: a small sticker-style SVG built from the idea's colours, as a data URI.
 * Kept well under 1 KB so it fits the token's storage budget.
 */
export function tokenIconSvg(idea: Pick<LaunchIdea, "ticker" | "colors">): string {
  const { primary, accent, background, text } = idea.colors;
  const label = esc(idea.ticker.slice(0, 4).toUpperCase());
  const size = label.length <= 2 ? 30 : label.length === 3 ? 24 : 19;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="24" fill="${background}"/>` +
    `<circle cx="48" cy="48" r="36" fill="${primary}" stroke="${text}" stroke-width="5"/>` +
    `<circle cx="48" cy="48" r="26" fill="none" stroke="${accent}" stroke-width="4" stroke-dasharray="6 5"/>` +
    `<text x="48" y="${48 + size * 0.36}" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" ` +
    `font-weight="900" font-size="${size}" fill="${text}">${label}</text></svg>`
  );
}

export function tokenIconDataUri(idea: Pick<LaunchIdea, "ticker" | "colors">): string {
  return `data:image/svg+xml,${encodeURIComponent(tokenIconSvg(idea))}`;
}
