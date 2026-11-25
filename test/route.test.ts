import { describe, expect, it } from 'vitest';
import { routeMessage, ROUTING_SYSTEM_PROMPT } from '../src/chat/route.js';
import { routed, scriptedLlm } from './helpers/llm.js';

describe('routeMessage', () => {
  it('returns the intent and query the model gives', async () => {
    const llm = scriptedLlm(routed('action_request', 'cancel order 1182'));
    expect(await routeMessage(llm, [], 'Cancel order 1182')).toEqual({
      intent: 'action_request',
      query: 'cancel order 1182',
    });
    expect(llm.requests[0]?.system).toBe(ROUTING_SYSTEM_PROMPT);
  });

  it('gives the model the conversation and the latest message', async () => {
    const llm = scriptedLlm(routed('question', 'international shipping time'));
    await routeMessage(
      llm,
      [
        { role: 'user', content: 'How long does shipping take?' },
        { role: 'assistant', content: 'Five to seven business days [1].' },
      ],
      'and abroad?',
    );
    const content = llm.requests[0]?.messages[0]?.content ?? '';
    expect(content).toContain('Customer: How long does shipping take?');
    expect(content).toContain('Assistant: Five to seven business days [1].');
    expect(content).toContain('and abroad?');
  });

  it('reads JSON wrapped in prose or a code fence', async () => {
    const llm = scriptedLlm(
      'Sure:\n```json\n{"intent": "human_request", "query": "talk to a person"}\n```',
    );
    expect((await routeMessage(llm, [], 'get me a human')).intent).toBe('human_request');
  });

  it.each([
    ['not JSON at all', 'I think this is a question.'],
    ['an unknown intent', '{"intent": "refund_now", "query": "x"}'],
    ['a missing query', '{"intent": "question"}'],
    ['an empty reply', ''],
  ])('treats %s as a question and searches the message as written', async (_label, reply) => {
    const llm = scriptedLlm(reply);
    expect(await routeMessage(llm, [], 'Where is my order?')).toEqual({
      intent: 'question',
      query: 'Where is my order?',
    });
  });

  it('falls back the same way when the model call fails', async () => {
    const llm = scriptedLlm(new Error('model down'));
    expect(await routeMessage(llm, [], 'Where is my order?')).toEqual({
      intent: 'question',
      query: 'Where is my order?',
    });
  });
});
