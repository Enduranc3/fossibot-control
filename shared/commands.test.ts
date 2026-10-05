import { describe, expect, it } from 'vitest';
import { WRITABLE, validateCommand } from './commands.ts';
import { KEY } from './protocol.ts';

describe('WRITABLE', () => {
  it('uses the same register ids and keys as the codec', () => {
    for (const [id, spec] of Object.entries(WRITABLE)) expect(KEY[id]).toBe(spec.key);
  });
});

describe('validateCommand', () => {
  it('accepts valid values', () => {
    expect(validateCommand('acOn', 1)).toBeNull();
    expect(validateCommand('chargePowerW', 500)).toBeNull();
    expect(validateCommand('led', 3)).toBeNull();
  });

  it('rejects unknown registers, read-only registers and prototype keys', () => {
    expect(validateCommand('soc', 50)).not.toBeNull();
    expect(validateCommand('nope', 1)).not.toBeNull();
    expect(validateCommand('__proto__', 1)).not.toBeNull();
  });

  it('rejects out-of-range, off-step and non-integer values', () => {
    expect(validateCommand('chargeLimit', 59)).not.toBeNull();
    expect(validateCommand('chargePowerW', 550)).not.toBeNull();
    expect(validateCommand('acOn', 0.5)).not.toBeNull();
    expect(validateCommand('acOn', '1')).not.toBeNull();
  });
});
