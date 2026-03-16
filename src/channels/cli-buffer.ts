/**
 * Lightweight buffer channel for CLI API hot-plug.
 * Always registered in the background process.
 * Owns `cli:*` JIDs and buffers agent responses in memory
 * for the HTTP API to poll.
 */
import { registerChannel } from './registry.js';
import { Channel } from '../types.js';

export class CliBufferChannel implements Channel {
  name = 'cli-buffer';
  private responses = new Map<string, string[]>();

  async connect(): Promise<void> {}

  async sendMessage(jid: string, text: string): Promise<void> {
    const existing = this.responses.get(jid) || [];
    existing.push(text);
    this.responses.set(jid, existing);
  }

  /** Return and clear buffered responses for a JID */
  getResponses(jid: string): string[] {
    const msgs = this.responses.get(jid) || [];
    this.responses.delete(jid);
    return msgs;
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {}
}

// Always register — acts as fallback for cli:* JIDs when
// the full CLI channel (NANOCLAW_CLI=1) is not active
registerChannel('cli-buffer', () => new CliBufferChannel());
