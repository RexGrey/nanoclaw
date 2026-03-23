import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getAllRegisteredGroups,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import type { NewMessage, RegisteredGroup } from './types.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

const realGroups: Record<string, RegisteredGroup> = {
  'tg:alpha': {
    name: 'Alpha',
    folder: 'alpha',
    trigger: '@bot',
    added_at: '2026-03-20T00:00:00.000Z',
    requiresTrigger: true,
  },
  'dc:alpha': {
    name: 'Alpha Mirror',
    folder: 'alpha',
    trigger: '@bot',
    added_at: '2026-03-20T00:00:01.000Z',
    requiresTrigger: true,
  },
  'tg:beta': {
    name: 'Beta',
    folder: 'beta',
    trigger: '@bot',
    added_at: '2026-03-20T00:00:02.000Z',
    requiresTrigger: true,
  },
};

describe('cli-api sessions', () => {
  beforeEach(() => {
    vi.useRealTimers();
    _initTestDatabase();
    for (const [jid, group] of Object.entries(realGroups)) {
      setRegisteredGroup(jid, group);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  async function startApi(): Promise<{
    token: string;
    registeredGroups: Record<string, RegisteredGroup>;
    request: (
      path: string,
      init?: {
        method?: string;
        body?: unknown;
      },
    ) => Promise<{
      status: number;
      json: unknown;
    }>;
  }> {
    const [{ createCliApi }, { CliBufferChannel }] = await Promise.all([
      import('./cli-api.js'),
      import('./channels/cli-buffer.js'),
    ]);

    const registeredGroups = { ...realGroups };
    const bufferChannel = new CliBufferChannel();

    const { handle, token } = createCliApi({
      registeredGroups: () => registeredGroups,
      registerRuntimeGroup: (jid, group) => {
        registeredGroups[jid] = group;
      },
      unregisterRuntimeGroup: (jid) => {
        delete registeredGroups[jid];
      },
      onMessage: (chatJid: string, msg: NewMessage) => {
        storeMessage(msg);

        if (msg.content === 'slow') {
          setTimeout(() => {
            void bufferChannel.sendMessage(chatJid, 'slow reply');
          }, 120);
          return;
        }

        if (msg.content.startsWith('reply:')) {
          setTimeout(() => {
            void bufferChannel.sendMessage(chatJid, `${msg.content} done`);
          }, 10);
        }
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      bufferChannel,
    });

    return {
      token,
      registeredGroups,
      request: async (
        path: string,
        init: {
          method?: string;
          body?: unknown;
        } = {},
      ) => {
        const response = await handle({
          method: init.method || 'GET',
          url: path,
          headers: {
            authorization: `Bearer ${token}`,
            host: '127.0.0.1',
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        return {
          status: response.status,
          json: response.body ? JSON.parse(response.body) : null,
        };
      },
    };
  }

  it('creates isolated sessions without polluting persisted registered groups', async () => {
    const { request, registeredGroups } = await startApi();
    const persistedBefore = Object.keys(getAllRegisteredGroups()).sort();

    const create = await request('/sessions', {
      method: 'POST',
      body: { group_jid: 'tg:alpha' },
    });
    expect(create.status).toBe(201);

    const body = create.json as {
      session_id: string;
      group: { jid: string; name: string; folder: string };
    };

    expect(body.session_id).toBeTruthy();
    expect(body.group).toEqual({
      jid: 'tg:alpha',
      name: 'Alpha',
      folder: 'alpha',
    });
    expect(
      Object.keys(registeredGroups).some((jid) => jid.startsWith('cli:')),
    ).toBe(true);
    expect(Object.keys(getAllRegisteredGroups()).sort()).toEqual(
      persistedBefore,
    );

    const groups = await request('/groups');
    const groupsBody = groups.json as {
      groups: Array<{ jid: string; name: string; folder: string }>;
    };
    expect(groupsBody.groups).toEqual([
      { jid: 'tg:alpha', name: 'Alpha', folder: 'alpha' },
      { jid: 'tg:beta', name: 'Beta', folder: 'beta' },
    ]);
  });

  it('isolates history by session and supports session deletion', async () => {
    const { request } = await startApi();

    const createAlpha = await request('/sessions', {
      method: 'POST',
      body: { group_jid: 'tg:alpha' },
    });
    const alpha = createAlpha.json as { session_id: string };

    const createBeta = await request('/sessions', {
      method: 'POST',
      body: { group_jid: 'tg:beta' },
    });
    const beta = createBeta.json as { session_id: string };

    const sendAlpha = await request('/message', {
      method: 'POST',
      body: {
        session_id: alpha.session_id,
        content: 'reply:alpha',
      },
    });
    expect(sendAlpha.status).toBe(200);

    const sendBeta = await request('/message', {
      method: 'POST',
      body: {
        session_id: beta.session_id,
        content: 'reply:beta',
      },
    });
    expect(sendBeta.status).toBe(200);

    const historyAlpha = await request(
      `/history?session_id=${alpha.session_id}&limit=10`,
    );
    const alphaBody = historyAlpha.json as {
      messages: Array<{ sender: string; content: string }>;
    };
    expect(alphaBody.messages.map((m) => m.content)).toEqual([
      'reply:alpha',
      'reply:alpha done',
    ]);

    const historyBeta = await request(
      `/history?session_id=${beta.session_id}&limit=10`,
    );
    const betaBody = historyBeta.json as {
      messages: Array<{ sender: string; content: string }>;
    };
    expect(betaBody.messages.map((m) => m.content)).toEqual([
      'reply:beta',
      'reply:beta done',
    ]);

    const deleted = await request(`/sessions/${alpha.session_id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await request(
      `/history?session_id=${alpha.session_id}&limit=10`,
    );
    expect(afterDelete.status).toBe(404);
  });

  it('rejects concurrent sends on the same session but allows different sessions', async () => {
    const { request } = await startApi();

    const createAlpha = await request('/sessions', {
      method: 'POST',
      body: { group_jid: 'tg:alpha' },
    });
    const alpha = createAlpha.json as { session_id: string };

    const createBeta = await request('/sessions', {
      method: 'POST',
      body: { group_jid: 'tg:beta' },
    });
    const beta = createBeta.json as { session_id: string };

    const slowRequest = request('/message', {
      method: 'POST',
      body: {
        session_id: alpha.session_id,
        content: 'slow',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const sameSession = await request('/message', {
      method: 'POST',
      body: {
        session_id: alpha.session_id,
        content: 'reply:blocked',
      },
    });
    expect(sameSession.status).toBe(409);

    const otherSession = await request('/message', {
      method: 'POST',
      body: {
        session_id: beta.session_id,
        content: 'reply:other',
      },
    });
    expect(otherSession.status).toBe(200);

    const slowResponse = await slowRequest;
    expect(slowResponse.status).toBe(200);
    const slowBody = slowResponse.json as { reply: string };
    expect(slowBody.reply).toBe('slow reply');
  });
});
