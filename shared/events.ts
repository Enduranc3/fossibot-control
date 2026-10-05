export type EventType =
  | 'grid_lost'
  | 'grid_restored'
  | 'output_changed'
  | 'setting_changed'
  | 'fault_set'
  | 'fault_cleared'
  | 'link_lost'
  | 'link_restored'
  | 'soc_low'
  | 'hub_started';

/** app = command from the web app, station = changed on the station itself, hub = detected by the hub. */
export type EventSource = 'app' | 'station' | 'hub';

export interface HubEvent {
  id?: number;
  /** Unix seconds. */
  ts: number;
  type: EventType;
  source: EventSource;
  data: Record<string, unknown>;
}
