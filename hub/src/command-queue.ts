import { WRITABLE, validateCommand } from '../../shared/commands.ts';
import { buildWriteCommand } from '../../shared/protocol.ts';
import type { LinkState } from './station-link.ts';

export type CommandErrorCode = 'invalid' | 'not_confirmed' | 'station_offline';

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type ReportFn = (registers: Record<string, number | string>, ts: number) => void;

export interface CommandLink {
  readonly state: LinkState;
  send(frame: Uint8Array): void;
  on(event: 'report', fn: ReportFn): unknown;
  off(event: 'report', fn: ReportFn): unknown;
}

export interface CommandQueueOptions {
  confirmMs?: number;
  retries?: number;
  /** How long a sent value counts as "requested by the app" for event attribution. */
  requestedTtlMs?: number;
  now?: () => number;
}

/**
 * Sends write commands one at a time. The station never answers a command directly, so a command
 * is confirmed only when a later report shows the requested value.
 */
export class CommandQueue {
  private readonly link: CommandLink;
  private readonly confirmMs: number;
  private readonly retries: number;
  private readonly requestedTtlMs: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly requested = new Map<string, { value: number; until: number }>();

  constructor(link: CommandLink, opts: CommandQueueOptions = {}) {
    this.link = link;
    this.confirmMs = opts.confirmMs ?? 3000;
    this.retries = opts.retries ?? 1;
    this.requestedTtlMs = opts.requestedTtlMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  execute(register: string, value: number): Promise<void> {
    const invalid = validateCommand(register, value);
    if (invalid) return Promise.reject(new CommandError('invalid', invalid));
    const run = () => this.run(register, value);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  wasRequested(register: string, value: number): boolean {
    const r = this.requested.get(register);
    return !!r && r.value === value && r.until >= this.now();
  }

  private async run(register: string, value: number): Promise<void> {
    if (this.link.state !== 'up') throw new CommandError('station_offline', "Станція не на зв'язку");
    const frame = buildWriteCommand(WRITABLE[register].key, value);
    this.requested.set(register, { value, until: this.now() + this.requestedTtlMs });
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const confirmed = this.waitFor(register, value);
      try {
        this.link.send(frame);
      } catch {
        throw new CommandError('station_offline', "Станція не на зв'язку");
      }
      if (await confirmed) return;
    }
    throw new CommandError('not_confirmed', 'Станція не підтвердила команду');
  }

  private waitFor(register: string, value: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onReport: ReportFn = (regs) => {
        if (regs[register] === value) done(true);
      };
      const timer = setTimeout(() => done(false), this.confirmMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.link.off('report', onReport);
        resolve(ok);
      };
      this.link.on('report', onReport);
    });
  }
}
