/**
 * Lightweight HTTP API for the CLI client to communicate with the running
 * NanoClaw process without stopping it.
 *
 * Uses a `cli:api` JID mapped to the target group's folder so that:
 * - Messages go through the normal message loop
 * - Responses route to the CliBufferChannel (not Telegram)
 * - Files and CLAUDE.md are shared with the target group
 *
 * Endpoints:
 *   GET  /groups           — list registered groups
 *   POST /message          — send a message, poll for response
 *   GET  /health           — health check (no auth required)
 *
 * All endpoints except /health require Bearer token auth.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  Server,
} from 'http';

import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';
import { getChatHistory } from './db.js';
import { RegisteredGroup, NewMessage } from './types.js';
import type { CliBufferChannel } from './channels/cli-buffer.js';

export const CLI_API_PORT = parseInt(process.env.CLI_API_PORT || '3002', 10);
export const CLI_API_TOKEN = crypto.randomUUID();

// Write token to file so cli-client can auto-read it
const TOKEN_FILE = path.resolve('store', '.cli-token');
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
fs.writeFileSync(TOKEN_FILE, CLI_API_TOKEN, { mode: 0o600 });
export { TOKEN_FILE };

const CLI_JID = 'cli:api';

interface CliApiDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  bufferChannel: CliBufferChannel;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startCliApi(deps: CliApiDeps): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS / Origin check — reject browser requests
      const origin = req.headers['origin'];
      if (origin) {
        json(res, 403, { error: 'Browser requests not allowed' });
        return;
      }

      // Health check (no auth)
      if (req.url === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true });
        return;
      }

      // Auth check
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${CLI_API_TOKEN}`) {
        json(res, 401, { error: 'Invalid token' });
        return;
      }

      // GET /groups — return all groups, deduplicated by folder
      if (req.url === '/groups' && req.method === 'GET') {
        const groups = deps.registeredGroups();
        const seen = new Set<string>();
        const list: Array<{ jid: string; name: string; folder: string }> = [];
        for (const [jid, g] of Object.entries(groups)) {
          if (seen.has(g.folder)) continue;
          seen.add(g.folder);
          list.push({ jid, name: g.name, folder: g.folder });
        }
        json(res, 200, { groups: list });
        return;
      }

      // GET /history?limit=N — recent CLI conversation history
      if (req.url?.startsWith('/history') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const messages = getChatHistory(CLI_JID, limit);
        json(res, 200, {
          messages: messages.map((m: NewMessage) => ({
            sender: m.sender_name,
            content: m.content,
            timestamp: m.timestamp,
            is_from_me: m.is_from_me,
          })),
        });
        return;
      }

      // POST /message
      if (req.url === '/message' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req));
          const { group_jid, content } = body as {
            group_jid: string;
            content: string;
          };

          if (!group_jid || !content) {
            json(res, 400, { error: 'group_jid and content required' });
            return;
          }

          const groups = deps.registeredGroups();
          const targetGroup = groups[group_jid];
          if (!targetGroup) {
            json(res, 404, { error: 'Group not found' });
            return;
          }

          // Register cli:api group bridged to target folder (once)
          if (!groups[CLI_JID]) {
            deps.registerGroup(CLI_JID, {
              name: `CLI → ${targetGroup.name}`,
              folder: targetGroup.folder,
              trigger: 'CLI API (no trigger)',
              added_at: new Date().toISOString(),
              requiresTrigger: false,
            });
          }

          const timestamp = new Date().toISOString();

          // Store chat metadata under cli:api JID
          deps.onChatMetadata(
            CLI_JID,
            timestamp,
            `CLI → ${targetGroup.name}`,
            'cli',
            false,
          );

          // Create and store message under cli:api JID
          const msg: NewMessage = {
            id: `cli-${crypto.randomUUID()}`,
            chat_jid: CLI_JID,
            sender: 'cli-user',
            sender_name: 'User',
            content,
            timestamp,
            is_from_me: false,
          };
          deps.onMessage(CLI_JID, msg);

          // Poll buffer channel for agent response (max 300s)
          const startTime = Date.now();
          const timeout = 300_000;
          const pollInterval = 500;

          const poll = (): Promise<string | null> =>
            new Promise((resolve) => {
              const check = () => {
                const responses = deps.bufferChannel.getResponses(CLI_JID);
                if (responses.length > 0) {
                  resolve(responses.join('\n'));
                  return;
                }
                if (Date.now() - startTime > timeout) {
                  resolve(null);
                  return;
                }
                setTimeout(check, pollInterval);
              };
              check();
            });

          const reply = await poll();
          if (reply) {
            json(res, 200, { reply, sender: ASSISTANT_NAME });
          } else {
            json(res, 504, { error: 'Agent did not respond in time' });
          }
        } catch (err) {
          json(res, 500, { error: 'Internal error' });
          logger.error({ err }, 'CLI API /message error');
        }
        return;
      }

      json(res, 404, { error: 'Not found' });
    });

    server.listen(CLI_API_PORT, '127.0.0.1', () => {
      logger.info({ port: CLI_API_PORT }, 'CLI API started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
