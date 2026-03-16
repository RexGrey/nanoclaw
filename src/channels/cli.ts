import readline from 'readline';
import crypto from 'crypto';
import { registerChannel } from './registry.js';
import { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';

class CliChannel implements Channel {
  name = 'cli';
  private rl: readline.Interface | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private jid = 'cli:default';

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    this.connected = true;

    this.rl.prompt();

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) {
        this.rl?.prompt();
        return;
      }

      const timestamp = new Date().toISOString();

      // Update chat metadata on every message (matches Telegram pattern)
      this.opts.onChatMetadata(this.jid, timestamp, 'CLI', 'cli', false);

      const msg: NewMessage = {
        id: `cli-${crypto.randomUUID()}`,
        chat_jid: this.jid,
        sender: 'cli-user',
        sender_name: 'User',
        content,
        timestamp,
        is_from_me: false,
      };

      this.opts.onMessage(this.jid, msg);
    });

    this.rl.on('close', () => {
      this.connected = false;
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) return;
    const prefix = jid !== this.jid ? `[${jid}] ` : '';
    console.log(`\n${prefix}${text}\n`);
    this.rl?.prompt();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return this.connected && jid.startsWith('cli:');
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    if (isTyping) {
      process.stdout.write('...\r');
    }
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.connected = false;
  }
}

// Self-register: only activate when env var set AND running in a TTY
registerChannel('cli', (opts) => {
  if (!process.env.NANOCLAW_CLI || !process.stdin.isTTY) return null;
  return new CliChannel(opts);
});
