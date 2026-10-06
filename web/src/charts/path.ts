/** One decimal is plenty for SVG coordinates and keeps path strings short. */
export const r1 = (n: number) => Math.round(n * 10) / 10;

/** Index runs of drawable points: a missing value or a gap longer than maxGap (seconds) ends a run. */
export function runs(ts: readonly number[], values: readonly (number | null)[], maxGap: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    if (cur.length && ts[i] - ts[cur[cur.length - 1]] > maxGap) {
      out.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) out.push(cur);
  return out;
}

type Map1 = (v: number) => number;

export function linePath(ts: readonly number[], values: readonly (number | null)[], x: Map1, y: Map1, maxGap: number): string {
  return runs(ts, values, maxGap)
    .map((run) => run.map((i, k) => `${k ? 'L' : 'M'}${r1(x(ts[i]))} ${r1(y(values[i] as number))}`).join('') + (run.length === 1 ? 'h0.01' : ''))
    .join('');
}

export function areaPath(ts: readonly number[], values: readonly (number | null)[], x: Map1, y: Map1, y0: number, maxGap: number): string {
  return runs(ts, values, maxGap)
    .filter((run) => run.length > 1)
    .map((run) => {
      const first = r1(x(ts[run[0]]));
      const last = r1(x(ts[run[run.length - 1]]));
      return `M${first} ${r1(y0)}${run.map((i) => `L${r1(x(ts[i]))} ${r1(y(values[i] as number))}`).join('')}L${last} ${r1(y0)}Z`;
    })
    .join('');
}

/** A column with a 4 px rounded top and a square base; empty for zero height. */
export function barPath(x: number, w: number, yTop: number, yBase: number): string {
  const height = yBase - yTop;
  if (!(height > 0) || !(w > 0)) return '';
  const r = Math.min(4, w / 2, height);
  const [x0, x1, t] = [r1(x), r1(x + w), r1(yTop)];
  return `M${x0} ${r1(yBase)}V${r1(yTop + r)}Q${x0} ${t} ${r1(x + r)} ${t}H${r1(x + w - r)}Q${x1} ${t} ${x1} ${r1(yTop + r)}V${r1(yBase)}Z`;
}

export function nearestIndex(ts: readonly number[], t: number): number {
  if (!ts.length) return -1;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(ts[hi] - t) < Math.abs(ts[lo] - t) ? hi : lo;
}

/** Intervals clipped to [from, to], sorted; an open one (no end yet) runs until now. */
export function clipIntervals(
  list: readonly { startTs: number; endTs: number | null }[],
  from: number,
  to: number,
  nowSec: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const o of list) {
    const a = Math.max(from, o.startTs);
    const b = Math.min(to, o.endTs ?? nowSec);
    if (b > a) out.push([a, b]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}
