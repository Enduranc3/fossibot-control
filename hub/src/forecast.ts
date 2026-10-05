export const DEFAULT_CAPACITY_WH = 1024;

/** Refines the usable capacity from a finished outage (spec §5). */
export function learnCapacity(
  currentWh: number,
  o: { outWh: number; socStart: number | null; socEnd: number | null },
  baseWh = DEFAULT_CAPACITY_WH,
): number {
  if (o.socStart === null || o.socEnd === null) return currentWh;
  const drop = o.socStart - o.socEnd;
  if (drop < 10 || o.outWh <= 0) return currentWh;
  const estimate = o.outWh / (drop / 100);
  const next = currentWh * 0.7 + estimate * 0.3;
  return Math.round(Math.min(baseWh * 1.5, Math.max(baseWh * 0.5, next)));
}

export function runtimeHours(socPct: number, dischargeLimitPct: number, capacityWh: number, loadW: number | null): number | null {
  if (loadW === null || loadW < 5) return null;
  return ((Math.max(0, socPct - dischargeLimitPct) / 100) * capacityWh) / loadW;
}

/** Moving average of the load over the last windowSec seconds. */
export class LoadAverager {
  private readonly windowSec: number;
  private samples: { sec: number; w: number }[] = [];

  constructor(windowSec = 900) {
    this.windowSec = windowSec;
  }

  add(sec: number, w: number): void {
    this.samples.push({ sec, w });
    const cut = sec - this.windowSec;
    while (this.samples.length && this.samples[0].sec <= cut) this.samples.shift();
  }

  average(): number | null {
    if (!this.samples.length) return null;
    return this.samples.reduce((a, s) => a + s.w, 0) / this.samples.length;
  }
}
