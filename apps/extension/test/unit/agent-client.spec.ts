import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../../src/host/egress/agent-client';
import { brand } from '../../src/host/egress/brand';
import { fakeStep, withImage } from './agent-fixtures';

const CONFIG = { apiKey: 'gsk_test_key_1234567890abcdef', baseUrl: 'https://api.groq.com/openai/v1', model: 'm' };

describe('agent client (bring your own key, no server)', () => {
  it('runs a step from guarded payload to validated plan with one call to the model API', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[{"op":"click","node":"e2"}]}' } }] })));
    const client = createAgentClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    const { session_id } = await client.openSession();
    const plan = (await client.sendStep(session_id, brand(withImage(fakeStep())), new AbortController().signal)) as { actions: { node: string }[] };
    expect(plan.actions[0]!.node).toBe('n-go');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    await client.closeSession(session_id);
  });

  it('refuses a payload the guard never produced, before anything is sent', async () => {
    const fetchImpl = vi.fn();
    const client = createAgentClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const { session_id } = await client.openSession();
    await expect(client.sendStep(session_id, fakeStep() as never, new AbortController().signal)).rejects.toThrow('EGRESS_REFUSES_UNGUARDED_PAYLOAD');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
