import fs from 'fs';
import path from 'path';
import readline from 'readline';

export interface GroupInfo {
  jid: string;
  name: string;
  folder: string;
}

export interface CliSessionInfo {
  session_id: string;
  group: GroupInfo;
}

export interface CliHistoryMessage {
  sender: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

export interface DraftSnapshot {
  prompt: string;
  draft: string;
  cursor: number;
}

export interface TerminalInputPort {
  clearVisibleInput(): void;
  getSnapshot(): DraftSnapshot;
  isLocked(): boolean;
  redraw(): void;
  restore(snapshot: DraftSnapshot): void;
}

const DEFAULT_PROMPT = 'You: ';
const CONTINUATION_PROMPT = '  > ';
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const TOKEN_FILE = path.resolve('store', '.cli-token');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API error ${status}: ${body}`);
  }
}

export class HttpCliApiClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string,
  ) {}

  static fromEnvironment(): HttpCliApiClient {
    const apiPort = process.env.CLI_API_PORT || '3002';
    let token = process.env.CLI_TOKEN;
    if (!token) {
      try {
        token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      } catch {
        throw new Error('无法读取 token。确保 NanoClaw 后台服务正在运行。');
      }
    }
    return new HttpCliApiClient(`http://127.0.0.1:${apiPort}`, token);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listGroups(): Promise<GroupInfo[]> {
    const data = (await this.fetchJson('/groups')) as { groups: GroupInfo[] };
    return data.groups;
  }

  async createSession(groupJid: string): Promise<CliSessionInfo> {
    return (await this.fetchJson('/sessions', {
      method: 'POST',
      body: JSON.stringify({ group_jid: groupJid }),
    })) as CliSessionInfo;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.fetchJson(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async getHistory(
    sessionId: string,
    limit: number,
  ): Promise<{ messages: CliHistoryMessage[] }> {
    return (await this.fetchJson(
      `/history?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`,
    )) as { messages: CliHistoryMessage[] };
  }

  async sendMessage(
    sessionId: string,
    content: string,
  ): Promise<{ reply: string; sender: string }> {
    return (await this.fetchJson('/message', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, content }),
    })) as { reply: string; sender: string };
  }

  private async fetchJson(
    endpoint: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`${this.apiBase}${endpoint}`, {
      ...init,
      headers,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, body);
    }
    return body ? JSON.parse(body) : null;
  }
}

export class InputController implements TerminalInputPort {
  private rl: readline.Interface | null = null;
  private submitHandler: ((line: string) => Promise<void>) | null = null;
  private closeHandler: (() => void) | null = null;
  private prompt = DEFAULT_PROMPT;
  private multilineBuffer: string[] = [];
  private locked = false;
  private bracketedPasteBuffer: string[] | null = null;
  private questionResolver: ((line: string) => void) | null = null;
  private questionPrompt: string | null = null;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  start(): void {
    if (this.rl) return;
    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      prompt: this.prompt,
    });

    this.enableBracketedPaste();
    this.rl.on('line', (line) => {
      void this.handleLine(line);
    });
    this.rl.on('close', () => {
      this.disableBracketedPaste();
      this.closeHandler?.();
    });
    this.rl.prompt();
  }

  setSubmitHandler(handler: (line: string) => Promise<void>): void {
    this.submitHandler = handler;
  }

  setCloseHandler(handler: () => void): void {
    this.closeHandler = handler;
  }

  lock(): void {
    this.locked = true;
    this.clearVisibleInput();
    this.rl?.pause();
  }

  unlock(): void {
    this.locked = false;
    this.rl?.resume();
    this.redraw();
  }

  async ask(promptText: string): Promise<string> {
    if (!this.rl) {
      throw new Error('Input controller not started');
    }

    return new Promise((resolve) => {
      this.multilineBuffer = [];
      this.questionPrompt = promptText;
      this.questionResolver = resolve;
      this.prompt = promptText;
      this.rl!.setPrompt(this.prompt);
      this.rl!.prompt();
    });
  }

  clearVisibleInput(): void {
    if (!this.rl || !this.output.isTTY) return;
    const pos = this.rl.getCursorPos();
    readline.moveCursor(this.output, 0, -pos.rows);
    readline.cursorTo(this.output, 0);
    readline.clearScreenDown(this.output);
  }

  getSnapshot(): DraftSnapshot {
    return {
      prompt: this.prompt,
      draft: this.rl?.line || '',
      cursor: this.getCursor(),
    };
  }

  isLocked(): boolean {
    return this.locked;
  }

  redraw(): void {
    if (this.locked) return;
    this.restore(this.getSnapshot());
  }

  restore(snapshot: DraftSnapshot): void {
    if (!this.rl) return;
    this.prompt = snapshot.prompt;
    this.clearVisibleInput();
    this.rl.setPrompt(this.prompt);
    this.rl.prompt();
    if (snapshot.draft) {
      this.rl.write(snapshot.draft);
      const delta = snapshot.draft.length - snapshot.cursor;
      if (delta > 0) {
        readline.moveCursor(this.output, -delta, 0);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.rl) return;
    this.disableBracketedPaste();
    this.rl.close();
    this.rl = null;
  }

  private async handleLine(line: string): Promise<void> {
    if (!this.rl || this.locked) return;

    if (this.questionResolver) {
      const resolve = this.questionResolver;
      this.questionResolver = null;
      this.questionPrompt = null;
      this.prompt = DEFAULT_PROMPT;
      this.rl.setPrompt(this.prompt);
      resolve(line.trim());
      this.rl.prompt();
      return;
    }

    const pasted = this.consumeBracketedPaste(line);
    if (pasted === null) {
      this.prompt = CONTINUATION_PROMPT;
      this.rl.setPrompt(this.prompt);
      this.rl.prompt();
      return;
    }
    if (typeof pasted === 'string') {
      this.loadDraftFromText(pasted);
      return;
    }

    if (line.endsWith('\\')) {
      this.multilineBuffer.push(line.slice(0, -1));
      this.prompt = CONTINUATION_PROMPT;
      this.rl.setPrompt(this.prompt);
      this.rl.prompt();
      return;
    }

    let content = line;
    if (this.multilineBuffer.length > 0) {
      this.multilineBuffer.push(line);
      content = this.multilineBuffer.join('\n');
      this.multilineBuffer = [];
      this.prompt = DEFAULT_PROMPT;
      this.rl.setPrompt(this.prompt);
    }

    if (this.submitHandler) {
      await this.submitHandler(content);
    }
    if (!this.locked) {
      this.rl.prompt();
    }
  }

  private consumeBracketedPaste(line: string): string | null | undefined {
    if (
      this.bracketedPasteBuffer === null &&
      !line.includes(BRACKETED_PASTE_START)
    ) {
      return undefined;
    }

    if (this.bracketedPasteBuffer === null) {
      this.bracketedPasteBuffer = [];
    }
    this.bracketedPasteBuffer.push(line);

    if (!line.includes(BRACKETED_PASTE_END)) {
      return null;
    }

    const pasted = this.bracketedPasteBuffer
      .join('\n')
      .replaceAll(BRACKETED_PASTE_START, '')
      .replaceAll(BRACKETED_PASTE_END, '');
    this.bracketedPasteBuffer = null;
    return pasted;
  }

  private loadDraftFromText(text: string): void {
    if (!this.rl) return;

    const lines = text.split('\n');
    this.multilineBuffer = lines.length > 1 ? lines.slice(0, -1) : [];
    this.prompt =
      this.multilineBuffer.length > 0 ? CONTINUATION_PROMPT : DEFAULT_PROMPT;
    this.rl.setPrompt(this.prompt);
    this.clearVisibleInput();
    this.rl.prompt();
    if (lines.at(-1)) {
      this.rl.write(lines.at(-1)!);
    }
  }

  private getCursor(): number {
    if (!this.rl) return 0;
    return typeof (this.rl as readline.Interface & { cursor?: number })
      .cursor === 'number'
      ? ((this.rl as readline.Interface & { cursor?: number }).cursor as number)
      : (this.rl.line || '').length;
  }

  private enableBracketedPaste(): void {
    if (this.output.isTTY) {
      this.output.write('\u001b[?2004h');
    }
  }

  private disableBracketedPaste(): void {
    if (this.output.isTTY) {
      this.output.write('\u001b[?2004l');
    }
  }
}

export class TerminalRenderer {
  private waitingTimer: ReturnType<typeof setInterval> | null = null;
  private waitingLabel = 'waiting';
  private waitingStart = 0;

  constructor(
    private readonly stdout: Pick<NodeJS.WriteStream, 'write' | 'columns'>,
    private readonly input: TerminalInputPort,
  ) {}

  info(message: string): void {
    this.writeBlock(`${message}\n`);
  }

  error(message: string): void {
    this.writeBlock(`错误: ${message}\n`);
  }

  message(sender: string, content: string): void {
    this.writeBlock(`\n${sender}: ${content}\n`);
  }

  history(messages: CliHistoryMessage[]): void {
    if (messages.length === 0) {
      this.info('暂无对话历史');
      return;
    }
    const lines = [`\n--- 最近 ${messages.length} 条 ---`];
    for (const message of messages) {
      const time = message.timestamp.replace('T', ' ').slice(0, 19);
      lines.push(`[${time}] ${message.sender}: ${message.content}`);
    }
    lines.push('--- 结束 ---\n');
    this.writeBlock(`${lines.join('\n')}\n`);
  }

  groups(groups: GroupInfo[]): void {
    const lines = ['\n选择群组：'];
    groups.forEach((group, index) => {
      lines.push(`  ${index + 1}. ${group.name} [${group.folder}]`);
    });
    this.writeBlock(`${lines.join('\n')}\n`);
  }

  help(): void {
    this.writeBlock(
      [
        '',
        '命令:',
        '  /history [n]  查看当前会话历史',
        '  /switch       切换群组',
        '  /clear        清屏',
        '  /help         显示帮助',
        '  /exit         退出',
        '',
      ].join('\n'),
    );
  }

  clear(): void {
    this.stopWaiting();
    this.stdout.write('\u001bc');
    this.input.redraw();
  }

  redraw(): void {
    this.input.redraw();
  }

  startWaiting(label = 'waiting'): void {
    this.stopWaiting();
    this.waitingLabel = label;
    this.waitingStart = Date.now();
    this.renderWaiting();
    this.waitingTimer = setInterval(() => this.renderWaiting(), 1000);
  }

  stopWaiting(): void {
    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
      this.waitingTimer = null;
    }
    this.stdout.write('\r\u001b[2K');
  }

  private renderWaiting(): void {
    const elapsedSeconds = Math.floor((Date.now() - this.waitingStart) / 1000);
    this.stdout.write(`\r\u001b[2K${this.waitingLabel}... ${elapsedSeconds}s`);
  }

  private writeBlock(text: string): void {
    this.stopWaiting();
    if (this.input.isLocked()) {
      this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }

    const snapshot = this.input.getSnapshot();
    this.input.clearVisibleInput();
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    this.input.restore(snapshot);
  }
}

interface CommandHandlers {
  clear: () => void;
  exit: () => Promise<void>;
  help: () => void;
  history: (limit: number) => Promise<void>;
  switchGroup: () => Promise<void>;
}

export class CommandController {
  constructor(private readonly handlers: CommandHandlers) {}

  async handle(input: string): Promise<boolean> {
    if (!input.startsWith('/')) return false;

    const parts = input.trim().split(/\s+/);
    switch (parts[0]) {
      case '/history':
        await this.handlers.history(parseInt(parts[1] || '20', 10) || 20);
        return true;
      case '/switch':
        await this.handlers.switchGroup();
        return true;
      case '/clear':
        this.handlers.clear();
        return true;
      case '/help':
        this.handlers.help();
        return true;
      case '/exit':
      case '/quit':
        await this.handlers.exit();
        return true;
      default:
        return false;
    }
  }
}

export class CliTerminalApp {
  private session: CliSessionInfo | null = null;
  private shuttingDown = false;
  private readonly commands: CommandController;

  constructor(
    private readonly api: HttpCliApiClient,
    private readonly renderer: TerminalRenderer,
    private readonly input: InputController,
  ) {
    this.commands = new CommandController({
      clear: () => this.renderer.clear(),
      exit: async () => {
        await this.shutdown();
      },
      help: () => this.renderer.help(),
      history: async (limit) => {
        await this.showHistory(limit);
      },
      switchGroup: async () => {
        await this.switchGroup();
      },
    });
  }

  async start(): Promise<void> {
    const alive = await this.api.healthCheck();
    if (!alive) {
      throw new Error('NanoClaw 后台服务没有运行，请先启动后台服务');
    }

    this.input.start();
    this.input.setSubmitHandler(async (line) => {
      await this.handleSubmission(line);
    });
    this.input.setCloseHandler(() => {
      void this.shutdown(false);
    });

    process.on('SIGWINCH', () => {
      this.renderer.redraw();
    });

    const group = await this.selectGroup();
    await this.attachGroup(group);
    this.renderer.info(`已连接: ${group.name}`);
  }

  private async handleSubmission(raw: string): Promise<void> {
    const content = raw.trim();
    if (!content) return;

    if (await this.commands.handle(content)) {
      return;
    }
    if (!this.session) {
      this.renderer.error('当前没有活动会话');
      return;
    }

    this.input.lock();
    this.renderer.startWaiting('waiting');
    try {
      const reply = await this.api.sendMessage(
        this.session.session_id,
        content,
      );
      this.renderer.message(reply.sender, reply.reply);
    } catch (err) {
      this.renderer.error(this.formatError(err));
    } finally {
      this.input.unlock();
    }
  }

  private async showHistory(limit: number): Promise<void> {
    if (!this.session) {
      this.renderer.error('当前没有活动会话');
      return;
    }

    try {
      const data = await this.api.getHistory(this.session.session_id, limit);
      this.renderer.history(data.messages);
    } catch (err) {
      this.renderer.error(this.formatError(err));
    }
  }

  private async switchGroup(): Promise<void> {
    const group = await this.selectGroup();
    this.renderer.clear();
    await this.attachGroup(group);
    this.renderer.info(`已切换到: ${group.name}`);
  }

  private async attachGroup(group: GroupInfo): Promise<void> {
    if (this.session) {
      try {
        await this.api.deleteSession(this.session.session_id);
      } catch {
        // Best-effort cleanup on switch.
      }
    }
    this.session = await this.api.createSession(group.jid);
  }

  private async selectGroup(): Promise<GroupInfo> {
    const groups = await this.api.listGroups();
    if (groups.length === 0) {
      throw new Error('没有已注册的群组');
    }

    while (true) {
      this.renderer.groups(groups);
      const answer = await this.input.ask('输入编号: ');
      const index = parseInt(answer, 10);
      if (index >= 1 && index <= groups.length) {
        return groups[index - 1];
      }
      this.renderer.error('无效编号');
    }
  }

  private async shutdown(closeInput: boolean = true): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.session) {
      try {
        await this.api.deleteSession(this.session.session_id);
      } catch {
        // Best-effort cleanup on shutdown.
      }
    }

    if (closeInput) {
      await this.input.close();
    }
    process.exit(0);
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiError) {
      try {
        const parsed = JSON.parse(err.body) as { error?: string };
        return parsed.error || err.body;
      } catch {
        return err.body;
      }
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}

export async function runCliClient(): Promise<void> {
  const api = HttpCliApiClient.fromEnvironment();
  const input = new InputController();
  const renderer = new TerminalRenderer(process.stdout, input);
  const app = new CliTerminalApp(api, renderer, input);
  await app.start();
}
