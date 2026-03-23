/**
 * Lightweight HTTP API for the terminal client to communicate with the running
 * NanoClaw process without stopping it.
 *
 * The public HTTP surface is session-based:
 * - GET    /groups
 * - POST   /sessions
 * - DELETE /sessions/:id
 * - GET    /history?session_id=...&limit=N
 * - POST   /message
 * - GET    /health
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  Server,
} from 'http';

import { ASSISTANT_NAME } from './config.js';
import { getChatHistory, storeMessage } from './db.js';
import { logger } from './logger.js';
import type { CliBufferChannel } from './channels/cli-buffer.js';
import { NewMessage, RegisteredGroup } from './types.js';

export const CLI_API_PORT = parseInt(process.env.CLI_API_PORT || '3002', 10);
export const CLI_API_TOKEN = crypto.randomUUID();
export const TOKEN_FILE = path.resolve('store', '.cli-token');

fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });

interface CliSession {
  sessionId: string;
  cliJid: string;
  targetGroupJid: string;
  groupName: string;
  folder: string;
  busy: boolean;
  createdAt: string;
  lastUsedAt: string;
}

interface CliApiDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerRuntimeGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterRuntimeGroup: (jid: string) => void;
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

interface CliApiRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

interface CliApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface CreateCliApiOptions {
  token?: string;
}

interface StartCliApiOptions extends CreateCliApiOptions {
  port?: number;
  writeTokenFile?: boolean;
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function jsonResponse(status: number, data: unknown): CliApiResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function emptyResponse(status: number): CliApiResponse {
  return {
    status,
    headers: {},
    body: '',
  };
}

function parseJsonBody<T>(body?: string): T | null {
  if (!body) return null;
  return JSON.parse(body) as T;
}

function parseLimit(raw: string | null): number {
  const parsed = parseInt(raw || '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 200);
}

function listRealGroups(
  groups: Record<string, RegisteredGroup>,
): Array<{ jid: string; name: string; folder: string }> {
  const ordered = Object.entries(groups)
    .filter(([jid]) => !jid.startsWith('cli:'))
    .sort((a, b) => {
      if (a[1].folder !== b[1].folder) {
        return a[1].folder.localeCompare(b[1].folder);
      }
      if (a[1].name !== b[1].name) {
        return a[1].name.localeCompare(b[1].name);
      }
      return a[0].localeCompare(b[0]);
    });

  const seen = new Set<string>();
  const result: Array<{ jid: string; name: string; folder: string }> = [];
  for (const [jid, group] of ordered) {
    if (seen.has(group.folder)) continue;
    seen.add(group.folder);
    result.push({ jid, name: group.name, folder: group.folder });
  }
  return result;
}

function writeTokenFile(token: string): void {
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

async function waitForReply(
  bufferChannel: CliBufferChannel,
  jid: string,
  timeoutMs: number,
): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 100;

  return new Promise((resolve) => {
    const check = () => {
      const responses = bufferChannel.getResponses(jid);
      if (responses.length > 0) {
        resolve(responses.join('\n'));
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, pollInterval);
    };
    check();
  });
}

export function createCliApi(
  deps: CliApiDeps,
  options: CreateCliApiOptions = {},
): {
  token: string;
  handle: (request: CliApiRequest) => Promise<CliApiResponse>;
} {
  const token = options.token || CLI_API_TOKEN;
  const sessions = new Map<string, CliSession>();

  const handle = async (request: CliApiRequest): Promise<CliApiResponse> => {
    if (request.headers.origin) {
      return jsonResponse(403, { error: 'Browser requests not allowed' });
    }

    const method = request.method || 'GET';
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`,
    );

    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse(200, { ok: true });
    }

    if (request.headers.authorization !== `Bearer ${token}`) {
      return jsonResponse(401, { error: 'Invalid token' });
    }

    if (url.pathname === '/groups' && method === 'GET') {
      return jsonResponse(200, {
        groups: listRealGroups(deps.registeredGroups()),
      });
    }

    if (url.pathname === '/sessions' && method === 'POST') {
      try {
        const body = parseJsonBody<{ group_jid?: string }>(request.body);
        const groupJid = body?.group_jid;
        if (!groupJid) {
          return jsonResponse(400, { error: 'group_jid required' });
        }
        if (groupJid.startsWith('cli:')) {
          return jsonResponse(404, { error: 'Group not found' });
        }

        const targetGroup = deps.registeredGroups()[groupJid];
        if (!targetGroup) {
          return jsonResponse(404, { error: 'Group not found' });
        }

        const sessionId = crypto.randomUUID();
        const cliJid = `cli:http:${sessionId}`;
        const createdAt = new Date().toISOString();

        deps.registerRuntimeGroup(cliJid, {
          name: `CLI → ${targetGroup.name}`,
          folder: targetGroup.folder,
          trigger: 'CLI API (no trigger)',
          added_at: createdAt,
          containerConfig: targetGroup.containerConfig,
          requiresTrigger: false,
          isMain: targetGroup.isMain,
        });

        sessions.set(sessionId, {
          sessionId,
          cliJid,
          targetGroupJid: groupJid,
          groupName: targetGroup.name,
          folder: targetGroup.folder,
          busy: false,
          createdAt,
          lastUsedAt: createdAt,
        });

        return jsonResponse(201, {
          session_id: sessionId,
          group: {
            jid: groupJid,
            name: targetGroup.name,
            folder: targetGroup.folder,
          },
        });
      } catch (err) {
        logger.error({ err }, 'CLI API /sessions error');
        return jsonResponse(500, { error: 'Internal error' });
      }
    }

    if (url.pathname.startsWith('/sessions/') && method === 'DELETE') {
      const sessionId = decodeURIComponent(
        url.pathname.slice('/sessions/'.length),
      );
      const session = sessions.get(sessionId);
      if (session) {
        deps.bufferChannel.clearResponses(session.cliJid);
        deps.unregisterRuntimeGroup(session.cliJid);
        sessions.delete(sessionId);
      }
      return emptyResponse(204);
    }

    if (url.pathname === '/history' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) {
        return jsonResponse(400, { error: 'session_id required' });
      }
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonResponse(404, { error: 'Session not found' });
      }

      const messages = getChatHistory(
        session.cliJid,
        parseLimit(url.searchParams.get('limit')),
      );
      session.lastUsedAt = new Date().toISOString();
      return jsonResponse(200, {
        messages: messages.map((message: NewMessage) => ({
          sender: message.sender_name,
          content: message.content,
          timestamp: message.timestamp,
          is_from_me: message.is_from_me,
        })),
      });
    }

    if (url.pathname === '/message' && method === 'POST') {
      let session: CliSession | undefined;
      try {
        const body = parseJsonBody<{ session_id?: string; content?: string }>(
          request.body,
        );
        const sessionId = body?.session_id;
        const content = body?.content?.trim();

        if (!sessionId || !content) {
          return jsonResponse(400, {
            error: 'session_id and content required',
          });
        }

        session = sessions.get(sessionId);
        if (!session) {
          return jsonResponse(404, { error: 'Session not found' });
        }
        if (session.busy) {
          return jsonResponse(409, { error: 'Session is busy' });
        }

        session.busy = true;
        session.lastUsedAt = new Date().toISOString();

        const timestamp = new Date().toISOString();
        deps.onChatMetadata(
          session.cliJid,
          timestamp,
          `CLI → ${session.groupName}`,
          'cli',
          false,
        );

        deps.onMessage(session.cliJid, {
          id: `cli-${crypto.randomUUID()}`,
          chat_jid: session.cliJid,
          sender: 'cli-user',
          sender_name: 'User',
          content,
          timestamp,
          is_from_me: false,
        });

        const reply = await waitForReply(
          deps.bufferChannel,
          session.cliJid,
          300_000,
        );
        if (!reply) {
          return jsonResponse(504, { error: 'Agent did not respond in time' });
        }

        storeMessage({
          id: `cli-reply-${crypto.randomUUID()}`,
          chat_jid: session.cliJid,
          sender: ASSISTANT_NAME,
          sender_name: ASSISTANT_NAME,
          content: reply,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        });

        return jsonResponse(200, { reply, sender: ASSISTANT_NAME });
      } catch (err) {
        logger.error({ err }, 'CLI API /message error');
        return jsonResponse(500, { error: 'Internal error' });
      } finally {
        if (session) {
          session.busy = false;
          session.lastUsedAt = new Date().toISOString();
        }
      }
    }

    return jsonResponse(404, { error: 'Not found' });
  };

  return { token, handle };
}

export function startCliApi(
  deps: CliApiDeps,
  options: StartCliApiOptions = {},
): Promise<Server> {
  const { handle, token } = createCliApi(deps, options);
  if (options.writeTokenFile !== false) {
    writeTokenFile(token);
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const response = await handle({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: normalizeHeaders(req.headers),
          body:
            req.method === 'POST' ||
            req.method === 'PUT' ||
            req.method === 'PATCH'
              ? await readBody(req)
              : undefined,
        });

        res.writeHead(response.status, response.headers);
        res.end(response.body);
      } catch (err) {
        logger.error({ err }, 'CLI API request failed unexpectedly');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });

    const port = options.port ?? CLI_API_PORT;
    server.listen(port, '127.0.0.1', () => {
      logger.info({ port, tokenFile: TOKEN_FILE }, 'CLI API started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
