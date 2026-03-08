import { describe, expect, it } from 'vitest';

import { isBufferedCliJid } from './cli-buffer.js';

describe('isBufferedCliJid', () => {
  it('matches hot-plug session JIDs', () => {
    expect(isBufferedCliJid('cli:http:abc123')).toBe(true);
  });

  it('matches the legacy cli:api JID', () => {
    expect(isBufferedCliJid('cli:api')).toBe(true);
  });

  it('does not match the embedded cli:default JID', () => {
    expect(isBufferedCliJid('cli:default')).toBe(false);
  });
});
