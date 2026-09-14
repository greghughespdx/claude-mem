import { describe, expect, it } from 'bun:test';
import { budgetObserverPrompt } from '../../src/services/worker/observer-prompt-budget.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

const instructions = 'INIT: return structured XML and never invent a missing value';
const instructionTail = 'Return either one or more <observation> blocks, or skip_summary.';

function observation(body: string): string {
  return `<observed_from_primary_session><parameters>${body}</parameters><outcome>${body}</outcome></observed_from_primary_session>\n${instructionTail}`;
}

describe('local observer prompt budget', () => {
  it('drops the oldest tool turns before touching the current observation', () => {
    const latest = observation('newest detail');
    const history: ConversationMessage[] = [
      { role: 'user', content: instructions },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: observation('old detail '.repeat(5000)) },
      { role: 'assistant', content: 'old observation' },
      { role: 'user', content: latest },
    ];
    const result = budgetObserverPrompt(history);
    expect(result.droppedTurns).toBe(1);
    expect(result.trimmedChars).toBe(0);
    expect(result.history[0]?.content).toBe(instructions);
    expect(result.history.at(-1)?.content).toBe(latest);
    expect(history).toHaveLength(5);
  });

  it('fits a synthetic 120k-token current observation without changing instructions', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: instructions },
      { role: 'user', content: observation('large payload '.repeat(22000)) },
    ];
    const result = budgetObserverPrompt(history);
    expect(result.beforeTokens).toBeGreaterThan(120000);
    expect(result.afterTokens).toBeLessThanOrEqual(26624);
    expect(result.trimmedChars).toBeGreaterThan(0);
    expect(result.history[0]?.content).toBe(instructions);
    expect(result.history[1]?.content).toContain(instructionTail);
    expect(result.history[1]?.content).toContain('[older observation text removed to fit the context]');
    expect(history[1]?.content).not.toContain('[older observation text removed to fit the context]');
  });

  it('refuses to cut instructions when no observation body can be shortened', () => {
    expect(() => budgetObserverPrompt([{ role: 'user', content: instructions.repeat(30000) }]))
      .toThrow('instructions exceed');
  });

  it('shortens session context before instructions when an init prompt is oversized', () => {
    const init = `<session_start_context>${'old transcript '.repeat(30000)}</session_start_context>\n${instructions}`;
    const result = budgetObserverPrompt([{ role: 'user', content: init }]);
    expect(result.afterTokens).toBeLessThanOrEqual(26624);
    expect(result.history[0]?.content).toContain(instructions);
    expect(result.history[0]?.content).toContain('[older observation text removed to fit the context]');
  });

  it('keeps a long instruction message and trims a shorter observation body', () => {
    const longInstructions = `<outcome>${'instruction '.repeat(6000)}</outcome>${instructions}`;
    const history: ConversationMessage[] = [
      { role: 'user', content: longInstructions },
      { role: 'user', content: observation('new observation '.repeat(1000)) },
    ];
    const result = budgetObserverPrompt(history);
    expect(result.history[0]?.content).toBe(longInstructions);
    expect(result.history[1]?.content).toContain(instructionTail);
    expect(result.trimmedChars).toBeGreaterThan(0);
  });

  it('sends the bounded copy to the local 32k endpoint without mutating history', async () => {
    const originalFetch = globalThis.fetch;
    let sent = '';
    globalThis.fetch = (async (_url, init) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '<observation>ok</observation>' } }] }));
    }) as typeof fetch;
    try {
      const history: ConversationMessage[] = [
        { role: 'user', content: instructions },
        { role: 'user', content: observation('large payload '.repeat(22000)) },
      ];
      const provider = new OpenRouterProvider({} as never, {} as never);
      await (provider as any).query(history, {
        apiKey: 'fake', model: 'gpt-oss-32k', fallbackModels: [],
        apiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      });
      const body = JSON.parse(sent) as { messages: ConversationMessage[] };
      expect(Math.ceil(JSON.stringify(body.messages).length / 3)).toBeLessThanOrEqual(26624);
      expect(body.messages[0]?.content).toContain(instructions);
      expect(body.messages.at(-1)?.content).toContain(instructionTail);
      expect(history[1]?.content).not.toContain('[older observation text removed to fit the context]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves the separate summary path unchanged for later work', async () => {
    const originalFetch = globalThis.fetch;
    let sent = '';
    globalThis.fetch = (async (_url, init) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '<summary>ok</summary>' } }] }));
    }) as typeof fetch;
    try {
      const summary = '--- SUMMARY ---\n' + 'long session answer '.repeat(22000);
      const provider = new OpenRouterProvider({} as never, {} as never);
      await (provider as any).query([{ role: 'user', content: summary }], {
        apiKey: 'fake', model: 'gpt-oss-32k', fallbackModels: [],
        apiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      });
      const body = JSON.parse(sent) as { messages: ConversationMessage[] };
      expect(body.messages[0]?.content).toBe(summary);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
