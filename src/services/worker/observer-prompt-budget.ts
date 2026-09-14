import type { ConversationMessage } from '../worker-types.js';

// This is a conservative estimate, not a tokenizer. The reserve covers the
// reply and estimation error before a 32k local model sees the request.
const CONTEXT_TOKENS = 32_768;
const OUTPUT_TOKENS = 4_096;
const SAFETY_TOKENS = 2_048;
const CHARS_PER_TOKEN = 3;
const MAX_CHARS = (CONTEXT_TOKENS - OUTPUT_TOKENS - SAFETY_TOKENS) * CHARS_PER_TOKEN;
const ELISION = '[older observation text removed to fit the context]';

export interface BudgetedPrompt {
  history: ConversationMessage[];
  beforeTokens: number;
  afterTokens: number;
  droppedTurns: number;
  trimmedChars: number;
}

function estimatedTokens(history: ConversationMessage[]): number {
  return Math.ceil(JSON.stringify(history).length / CHARS_PER_TOKEN);
}

function trimLargestObservationBody(content: string, removeChars: number): string | null {
  const observedStart = content.indexOf('<observed_from_primary_session>');
  const observedEnd = observedStart < 0 ? -1 : content.indexOf('</observed_from_primary_session>', observedStart);
  const fields = ['parameters', 'outcome', 'user_request', 'session_start_context'].map(tag => {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = content.indexOf(open);
    const end = start < 0 ? -1 : content.indexOf(close, start + open.length);
    const insideObservation = observedStart >= 0 && start > observedStart && end < observedEnd;
    const dataField = tag === 'session_start_context' || insideObservation;
    return { start: start + open.length, end, length: end - start - open.length, dataField };
  }).filter(field => field.dataField && field.end >= 0 && field.length > ELISION.length);
  fields.sort((a, b) => b.length - a.length);
  const field = fields[0];
  if (!field) return null;
  const keep = Math.max(0, field.length - Math.max(removeChars, ELISION.length));
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return content.slice(0, field.start + head) + ELISION +
    content.slice(field.end - tail);
}

/** Bound the sent copy, keeping the init instructions and newest request intact. */
export function budgetObserverPrompt(history: ConversationMessage[]): BudgetedPrompt {
  const kept = history.map(message => ({ ...message }));
  const beforeTokens = estimatedTokens(kept);
  let droppedTurns = 0;
  let trimmedChars = 0;

  // Prior tool-use requests are the oldest expendable context. Drop their
  // replies with them so the remaining turns still tell a coherent story.
  for (let index = 1; estimatedTokens(kept) > CONTEXT_TOKENS - OUTPUT_TOKENS - SAFETY_TOKENS && index < kept.length - 1;) {
    if (kept[index]?.role === 'user' && kept[index]?.content.includes('<observed_from_primary_session>')) {
      kept.splice(index, kept[index + 1]?.role === 'assistant' ? 2 : 1);
      droppedTurns++;
    } else {
      index++;
    }
  }

  // An oversized current observation can cross the limit by itself. Only
  // its data fields may be shortened; the instruction tail is untouched.
  while (JSON.stringify(kept).length > MAX_CHARS) {
    const excess = JSON.stringify(kept).length - MAX_CHARS;
    const trimmable = kept.map((message, index) => ({ message, index }))
      .filter(entry => entry.message.role === 'user')
      .sort((a, b) => b.message.content.length - a.message.content.length)
      .map(entry => ({ ...entry, trimmed: trimLargestObservationBody(entry.message.content, excess + 256) }))
      .find(entry => entry.trimmed !== null && entry.trimmed.length < entry.message.content.length);
    if (!trimmable || trimmable.trimmed === null) {
      throw new Error('Observer prompt instructions exceed the local context budget');
    }
    trimmedChars += trimmable.message.content.length - trimmable.trimmed.length;
    kept[trimmable.index] = { ...trimmable.message, content: trimmable.trimmed };
  }

  return { history: kept, beforeTokens, afterTokens: estimatedTokens(kept), droppedTurns, trimmedChars };
}
