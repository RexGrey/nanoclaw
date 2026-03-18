#!/usr/bin/env tsx
/**
 * Lightweight CLI client that connects to the running NanoClaw process
 * via HTTP API. No need to stop the background service.
 *
 * Usage: CLI_TOKEN=<token> tsx src/cli-client.ts
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const API_PORT = process.env.CLI_API_PORT || '3002';
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const TOKEN_FILE = path.resolve('store', '.cli-token');

// Auto-read token from file, fallback to env var
let TOKEN = process.env.CLI_TOKEN;
if (!TOKEN) {
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    console.error('无法读取 token。确保 NanoClaw 后台服务正在运行。');
    process.exit(1);
  }
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

async function fetchJson(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function healthCheck(): Promise<boolean> {
  try {
    await fetch(`${API_BASE}/health`);
    return true;
  } catch {
    return false;
  }
}

interface GroupInfo {
  jid: string;
  name: string;
  folder: string;
}

async function selectGroup(): Promise<string> {
  const data = (await fetchJson('/groups')) as { groups: GroupInfo[] };
  const groups = data.groups;

  if (groups.length === 0) {
    console.error('没有已注册的群组');
    process.exit(1);
  }

  console.log('\n选择群组：');
  groups.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.name} [${g.folder}]`);
  });
  console.log('');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('输入编号: ', (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10);
      if (idx >= 1 && idx <= groups.length) {
        const selected = groups[idx - 1];
        console.log(`\n已连接: ${selected.name}\n`);
        resolve(selected.jid);
      } else {
        console.error('无效编号');
        process.exit(1);
      }
    });
  });
}

async function main(): Promise<void> {
  // Health check
  const alive = await healthCheck();
  if (!alive) {
    console.error('NanoClaw 后台服务没有运行，请先启动后台服务');
    process.exit(1);
  }

  const groupJid = await selectGroup();

  // Chat loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  let multilineBuffer: string[] = [];

  rl.prompt();

  rl.on('line', async (line) => {
    // Backslash continuation for multi-line input
    if (line.endsWith('\\')) {
      multilineBuffer.push(line.slice(0, -1));
      process.stdout.write('  > ');
      return;
    }

    if (multilineBuffer.length > 0) {
      multilineBuffer.push(line);
      line = multilineBuffer.join('\n');
      multilineBuffer = [];
    }

    const content = line.trim();
    if (!content) {
      rl.prompt();
      return;
    }

    if (content === '/quit' || content === '/exit') {
      console.log('\n再见！\n');
      rl.close();
      process.exit(0);
    }

    if (content.startsWith('/history')) {
      const parts = content.split(/\s+/);
      const limit = parseInt(parts[1], 10) || 20;
      try {
        const data = (await fetchJson(`/history?limit=${limit}`)) as {
          messages: Array<{
            sender: string;
            content: string;
            timestamp: string;
            is_from_me: boolean;
          }>;
        };
        if (data.messages.length === 0) {
          console.log('\n暂无对话历史\n');
        } else {
          console.log(`\n--- 最近 ${data.messages.length} 条 ---\n`);
          for (const m of data.messages) {
            const time = m.timestamp.replace('T', ' ').slice(0, 19);
            const label = m.is_from_me ? 'Andy' : 'You';
            console.log(`[${time}] ${label}: ${m.content}`);
          }
          console.log('\n--- 结束 ---\n');
        }
      } catch (err) {
        console.error(`\n错误: ${err}\n`);
      }
      rl.prompt();
      return;
    }

    process.stdout.write('...\n');

    try {
      const data = (await fetchJson('/message', {
        method: 'POST',
        body: JSON.stringify({ group_jid: groupJid, content }),
      })) as { reply: string; sender: string };

      console.log(`\n${data.sender}: ${data.reply}\n`);
    } catch (err) {
      console.error(`\n错误: ${err}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
