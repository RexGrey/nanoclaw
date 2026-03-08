import { describe, expect, it, vi } from 'vitest';

import type { DraftSnapshot, TerminalInputPort } from './cli-terminal.js';
import { TerminalRenderer } from './cli-terminal.js';

class FakeStdout {
  columns = 80;
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

class FakeInput implements TerminalInputPort {
  snapshot: DraftSnapshot = {
    prompt: 'You: ',
    draft: 'draft text',
    cursor: 3,
  };
  clearVisibleInput = vi.fn();
  restore = vi.fn();
  redraw = vi.fn();
  isLocked = vi.fn(() => false);
  getSnapshot = vi.fn(() => this.snapshot);
}

describe('TerminalRenderer', () => {
  it('restores draft and cursor after writing an async message block', () => {
    const stdout = new FakeStdout();
    const input = new FakeInput();
    const renderer = new TerminalRenderer(stdout as never, input);

    renderer.message('Assistant', 'hello');

    expect(input.clearVisibleInput).toHaveBeenCalledTimes(1);
    expect(input.restore).toHaveBeenCalledWith({
      prompt: 'You: ',
      draft: 'draft text',
      cursor: 3,
    });
    expect(stdout.writes.join('')).toContain('Assistant: hello');
  });

  it('redraws the current draft on resize without losing state', () => {
    const stdout = new FakeStdout();
    const input = new FakeInput();
    const renderer = new TerminalRenderer(stdout as never, input);

    renderer.redraw();

    expect(input.redraw).toHaveBeenCalledTimes(1);
    expect(input.restore).not.toHaveBeenCalled();
  });
});
