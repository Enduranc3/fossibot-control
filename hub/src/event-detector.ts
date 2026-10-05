import type { EventSource, EventType, HubEvent } from '../../shared/events.ts';
import type { Snapshot } from '../../shared/telemetry.ts';
import type { LinkState } from './station-link.ts';

export interface GridRule {
  lost(s: Snapshot): boolean;
  restored(s: Snapshot): boolean;
  lostAfterSec: number;
  restoredAfterSec: number;
}

/** Spec §5 fallback: no AC input while the battery is supplying the load. */
export const FALLBACK_GRID_RULE: GridRule = {
  lost: (s) => s.acInW <= 2 && s.outW > s.inW,
  restored: (s) => s.acInW > 2,
  lostAfterSec: 10,
  restoredAfterSec: 5,
};

export interface GridStatus {
  present: boolean | null;
  sinceSec: number | null;
}

export const SETTING_IDS = [
  'chargePowerW',
  'acRestoreOnPower',
  'screenTimeout',
  'acStandbyLegacy',
  'ecoMode',
  'chargeLimit',
  'dischargeLimit',
  'keySoundOff',
  'screenBrightness',
  'dcChargeCurrent',
  'dcStandby',
  'usbStandby',
  'acStandby',
] as const;

const OUTPUTS = [
  { id: 'acOn', name: 'ac' },
  { id: 'dcOn', name: 'dc' },
  { id: 'usbOn', name: 'usb' },
  { id: 'led', name: 'led' },
] as const;

const FAULT_KINDS = ['bms', 'pcs', 'pv'] as const;

export interface EventDetectorOptions {
  wasRequested(register: string, value: number): boolean;
  socLowThreshold(): number;
  emit(e: HubEvent): void;
  gridRule?: GridRule;
  /** false when the hub starts while an outage is still open in the database. */
  initialGridPresent?: boolean | null;
  onGrid?(g: GridStatus): void;
}

export class EventDetector {
  grid: GridStatus;
  private readonly opts: EventDetectorOptions;
  private readonly rule: GridRule;
  private prev: Snapshot | null = null;
  private candidate: { kind: 'lost' | 'restored'; sinceSec: number } | null = null;
  private socLowArmed = true;
  private linkSeenUp = false;
  private linkLost = false;

  constructor(opts: EventDetectorOptions) {
    this.opts = opts;
    this.rule = opts.gridRule ?? FALLBACK_GRID_RULE;
    this.grid = { present: opts.initialGridPresent ?? null, sinceSec: null };
  }

  onSnapshot(s: Snapshot): void {
    const sec = Math.floor(s.ts / 1000);
    this.detectGrid(s, sec);
    const p = this.prev;
    if (p) {
      for (const o of OUTPUTS) this.compare(p, s, o.id, sec, 'output_changed', { output: o.name });
      for (const id of SETTING_IDS) this.compare(p, s, id, sec, 'setting_changed', { register: id });
      for (const kind of FAULT_KINDS) {
        const before = p.faults[kind];
        const after = s.faults[kind];
        if (before === after) continue;
        if (after !== 0) this.emit(sec, 'fault_set', 'station', { kind, code: after });
        else this.emit(sec, 'fault_cleared', 'station', { kind, code: before });
      }
    }
    this.detectSocLow(s, sec);
    this.prev = s;
  }

  onLinkState(state: LinkState, sec: number): void {
    if (state === 'up') {
      if (this.linkLost) this.emit(sec, 'link_restored', 'hub', {});
      this.linkLost = false;
      this.linkSeenUp = true;
    } else if (this.linkSeenUp && !this.linkLost) {
      this.linkLost = true;
      this.candidate = null;
      this.emit(sec, 'link_lost', 'hub', {});
    }
  }

  private compare(p: Snapshot, s: Snapshot, id: string, sec: number, type: EventType, data: Record<string, unknown>) {
    const before = p.registers[id];
    const after = s.registers[id];
    if (typeof before !== 'number' || typeof after !== 'number' || before === after) return;
    const source: EventSource = this.opts.wasRequested(id, after) ? 'app' : 'station';
    this.emit(sec, type, source, { ...data, from: before, to: after });
  }

  private detectGrid(s: Snapshot, sec: number) {
    const present = this.grid.present;
    const kind =
      present !== false && this.rule.lost(s) ? 'lost' : present !== true && this.rule.restored(s) ? 'restored' : null;
    if (!kind) {
      this.candidate = null;
      return;
    }
    if (this.candidate?.kind !== kind) this.candidate = { kind, sinceSec: sec };
    const need = kind === 'lost' ? this.rule.lostAfterSec : this.rule.restoredAfterSec;
    if (sec - this.candidate.sinceSec < need) return;
    const since = this.candidate.sinceSec;
    const wasKnown = present !== null;
    this.candidate = null;
    this.grid = { present: kind === 'restored', sinceSec: since };
    this.opts.onGrid?.({ ...this.grid });
    if (kind === 'lost') this.emitAt(since, 'grid_lost', 'hub', { soc: s.soc, initial: !wasKnown });
    else if (wasKnown) this.emitAt(since, 'grid_restored', 'hub', { soc: s.soc });
  }

  private detectSocLow(s: Snapshot, sec: number) {
    const threshold = this.opts.socLowThreshold();
    if (this.socLowArmed && s.soc <= threshold) {
      this.socLowArmed = false;
      this.emit(sec, 'soc_low', 'hub', { soc: s.soc, threshold });
    } else if (!this.socLowArmed && s.soc >= threshold + 5) {
      this.socLowArmed = true;
    }
  }

  private emit(sec: number, type: EventType, source: EventSource, data: Record<string, unknown>) {
    this.emitAt(sec, type, source, data);
  }

  private emitAt(ts: number, type: EventType, source: EventSource, data: Record<string, unknown>) {
    this.opts.emit({ ts, type, source, data });
  }
}
