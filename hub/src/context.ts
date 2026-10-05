import type { Snapshot } from '../../shared/telemetry.ts';
import type { Auth } from './auth.ts';
import type { CommandQueue } from './command-queue.ts';
import type { Db } from './db.ts';
import type { GridStatus } from './event-detector.ts';
import type { Outage } from './outages.ts';
import type { PrefsStore } from './prefs.ts';
import type { LinkState } from './station-link.ts';

export interface EnergyTotals {
  gridInWh: number;
  solarInWh: number;
  outWh: number;
}

export interface StateView {
  link: LinkState;
  snapshot: Snapshot | null;
  grid: GridStatus;
  outage: Outage | null;
  forecast: {
    capacityWh: number;
    avgLoadW: number | null;
    runtimeHours: number | null;
    stationRemainingMin: number | null;
  };
  today: EnergyTotals;
}

export interface HubContext {
  db: Db;
  auth: Auth;
  queue: CommandQueue;
  prefs: PrefsStore;
  state(): StateView;
}
