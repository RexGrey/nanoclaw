/**
 * Lightweight HTTP API for the CLI client to communicate with the running
 * NanoClaw process without stopping it.
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
import { getMessagesSince } from './db.js';
import { RegisteredGroup, NewMessage } from './types.js';

export const CLI_API_PORT = parseInt(process.env.CLI_API_PORT || '3002', 10);
export const CLI_API_TOKEN = crypto.randomUUID();

// Write token to file so cli-client can auto-read it
const TOKEN_FILE = path.resolve('store', '.cli-token');
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
fs.writeFileSync(TOKEN_FILE, CLI_API_TOKEN, { mode: 0o600 });
export { TOKEN_FILE };

interface CliApiDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
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

      // GET /groups
      if (req.url === '/groups' && req.method === 'GET') {
        const groups = deps.registeredGroups();
        const list = Object.entries(groups).map(([jid, g]) => ({
          jid,
          name: g.name,
          folder: g.folder,
        }));
        json(res, 200, { groups: list });
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
          const group = groups[group_jid];
          if (!group) {
            json(res, 404, { error: 'Group not found' });
            return;
          }

          const timestamp = new Date().toISOString();

          // Store chat metadata
          deps.onChatMetadata(group_jid, timestamp, group.name, 'cli', false);

          // Create and store message
          const msg: NewMessage = {
            id: `cli-${crypto.randomUUID()}`,
            chat_jid: group_jid,
            sender: 'cli-user',
            sender_name: 'User',
            content,
            timestamp,
            is_from_me: false,
          };
          deps.onMessage(group_jid, msg);

          // Poll for agent response (max 120s)
          const startTime = Date.now();
          const timeout = 120_000;
          const pollInterval = 500;

          const poll = (): Promise<string | null> =>
            new Promise((resolve) => {
              const check = () => {
                const messages = getMessagesSince(
                  group_jid,
                  timestamp,
                  ASSISTANT_NAME,
                );
                // Look for bot responses after our message
                const botReply = messages.find(
                  (m) =>
                    m.sender_name === ASSISTANT_NAME &&
                    m.timestamp >= timestamp &&
                    m.id !== msg.id,
                );
                if (botReply) {
                  resolve(botReply.content);
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
