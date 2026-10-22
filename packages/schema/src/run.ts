// Client-side helpers for runs of up to MAX_RUN tokens split into MAX_BATCH-sized requests.
import { MAX_BATCH, MAX_RUN } from "./limits";
import type { LaunchIdea } from "./index";

/** Clamp a requested run size to 1..MAX_RUN (non-numbers -> 1). */
export function clampRun(n: unknown, max = MAX_RUN): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(max, v);
}

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size = MAX_BATCH): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Chunk sizes for a run of `total` ideas, e.g. 12 -> [5, 5, 2]. */
export function chunkSizes(total: number, size = MAX_BATCH): number[] {
  const out: number[] = [];
  for (let left = total; left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

/**
 * Runs `tasks` with at most `concurrency` in flight; each is retried up to `retries` times.
 * Results keep task order; a task that still fails yields `{ ok: false, error }` and the rest continue.
 */
export async function pool<T>(
  tasks: (() => Promise<T>)[],
  opts: { concurrency?: number; retries?: number; backoffMs?: number; onDone?: (i: number, r: PoolResult<T>) => void; stop?: () => boolean } = {},
): Promise<PoolResult<T>[]> {
  const { concurrency = 3, retries = 2, backoffMs = 800 } = opts;
  const out: PoolResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      let last: unknown;
      let r: PoolResult<T> | null = null;
      for (let a = 0; a <= retries && !opts.stop?.(); a++) {
        try {
          r = { ok: true, value: await tasks[i]() };
          break;
        } catch (e) {
          last = e;
          if ((e as { noRetry?: boolean })?.noRetry) break;
          if (a < retries) await new Promise((res) => setTimeout(res, backoffMs * (a + 1)));
        }
      }
      r ??= { ok: false, error: last instanceof Error ? last.message : String(last ?? "stopped") };
      out[i] = r;
      opts.onDone?.(i, r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return out;
}
export type PoolResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Adds `incoming` ideas to `seen`, dropping ones whose name or ticker is already used in the run.
 * A ticker clash with a new name is renamed (`ticker2`, ...) rather than dropped. Mutates `seen`.
 */
export function dedupeIdeas(incoming: LaunchIdea[], seen: { names: Set<string>; tickers: Set<string> }): LaunchIdea[] {
  const out: LaunchIdea[] = [];
  for (const idea of incoming) {
    const nk = idea.name.trim().toLowerCase();
    if (seen.names.has(nk)) continue;
    let t = idea.ticker;
    for (let k = 2; seen.tickers.has(t); k++) t = `${idea.ticker.slice(0, 16 - String(k).length)}${k}`;
    seen.names.add(nk);
    seen.tickers.add(t);
    out.push(t === idea.ticker ? idea : { ...idea, ticker: t });
  }
  return out;
}

/** Estimated credit cost of generating `count` ideas at `perIdea` yocto each. */
export const generationCost = (count: number, perIdea: bigint | string) => BigInt(perIdea) * BigInt(count);
