import crypto from 'crypto';

import { registerChannel } from './registry.js';
import { ASSISTANT_NAME } from '../config.js';
import { InputController, TerminalRenderer } from '../cli-terminal.js';
import { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';

class CliChannel implements Channel {
  name = 'cli';
  private input: InputController | null = null;
  private renderer: TerminalRenderer | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private jid = 'cli:default';

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  /** Call after group selection menu to create readline and start accepting input */
  startPrompt(): void {
    this.input = new InputController(process.stdin, process.stdout);
    this.renderer = new TerminalRenderer(process.stdout, this.input);
    this.input.setSubmitHandler(async (line) => {
      const content = line.trim();
      if (!content) {
        return;
      }
      if (content === '/quit' || content === '/exit') {
        await this.input?.close();
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
    this.input.setCloseHandler(() => {
      this.connected = false;
    });
    this.input.start();
  }

  async connect(): Promise<void> {
    // Just mark as connected; readline is created later by startPrompt()
    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) return;
    const prefix = jid !== this.jid ? `[${jid}] ` : '';
    this.renderer?.message(ASSISTANT_NAME, `${prefix}${text}`);
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
      this.renderer?.startWaiting('thinking');
      return;
    }
    this.renderer?.stopWaiting();
  }

  async disconnect(): Promise<void> {
    await this.input?.close();
    this.connected = false;
  }
}

// Self-register: only activate when env var set AND running in a TTY
registerChannel('cli', (opts) => {
  if (!process.env.NANOCLAW_CLI || !process.stdin.isTTY) return null;
  return new CliChannel(opts);
});
