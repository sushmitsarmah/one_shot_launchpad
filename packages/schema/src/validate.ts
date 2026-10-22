// Client + server checks for (possibly hand-edited) ideas before launch. Per-field rules come from the
// LaunchIdea schema (which mirrors the factory's ticker rule); run-level rules add uniqueness.
import { LaunchIdea } from "./index";

export type IdeaField = "name" | "ticker" | "tagline" | "description" | "colors";
export type IdeaErrors = Partial<Record<IdeaField, string>>;
/** JustHoot's symbol limit (see justhootProblem in the API). */
export const JUSTHOOT_TICKER_MAX = 10;

/** Field errors for one idea (empty object = valid). */
export function ideaErrors(idea: LaunchIdea, opts: { venue?: string } = {}): IdeaErrors {
  const out: IdeaErrors = {};
  const r = LaunchIdea.safeParse(idea);
  if (!r.success) {
    for (const iss of r.error.issues) {
      const f = String(iss.path[0] ?? "") as IdeaField;
      if (f && !out[f]) out[f] = friendly(f, iss.message);
    }
  }
  if (!out.ticker && opts.venue === "justhoot" && idea.ticker.length > JUSTHOOT_TICKER_MAX) out.ticker = `JustHoot allows at most ${JUSTHOOT_TICKER_MAX} characters`;
  return out;
}

function friendly(f: IdeaField, msg: string): string {
  if (f === "ticker") return "2-16 chars, lowercase a-z/0-9, starts with a letter";
  if (f === "name") return "2-40 characters";
  if (f === "tagline") return "3-120 characters";
  if (f === "description") return "10-600 characters";
  if (f === "colors") return "colours must be #RRGGBB";
  return msg;
}

/** Errors for every idea in a run, adding duplicate name / ticker checks among the `selected` ones. */
export function runErrors(ideas: LaunchIdea[], selected: boolean[] = ideas.map(() => true), opts: { venue?: string } = {}): IdeaErrors[] {
  const errs = ideas.map((i) => ideaErrors(i, opts));
  const names = new Map<string, number>();
  const tickers = new Map<string, number>();
  ideas.forEach((idea, i) => {
    if (!selected[i]) return;
    const n = idea.name.trim().toLowerCase();
    const t = idea.ticker;
    if (names.has(n)) errs[i].name ??= `same name as #${names.get(n)! + 1}`;
    else names.set(n, i);
    if (tickers.has(t)) errs[i].ticker ??= `same ticker as #${tickers.get(t)! + 1}`;
    else tickers.set(t, i);
  });
  return errs;
}

export const hasErrors = (e: IdeaErrors) => Object.keys(e).length > 0;

/** Rotates a #RRGGBB colour's hue by `deg` (local, free "new icon colours"). */
export function rotateHue(hex: string, deg: number): string {
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** New icon/site palette: hue-rotates the accent colours, keeps background/text (so contrast holds). */
export function shufflePalette(idea: LaunchIdea, deg = 67): LaunchIdea {
  const c = idea.colors;
  return { ...idea, colors: { ...c, primary: rotateHue(c.primary, deg), secondary: rotateHue(c.secondary, deg), accent: rotateHue(c.accent, deg) } };
}
