// Cloud LLM providers (bring-your-own API key). These run NO on-device model and need
// no WebGPU — they call the provider's HTTP API directly from the browser. That is a
// deliberate privacy tradeoff (the summary content + your key are sent to the provider),
// so it's opt-in and the key is stored locally. All three endpoints are browser-callable
// (CORS): Gemini via the ?key= param, OpenAI via a Bearer key, Anthropic via x-api-key +
// the anthropic-dangerous-direct-browser-access header.
import type { CloudProvider } from '../../types';

export interface CloudMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CloudProviderInfo {
  id: CloudProvider;
  label: string; // human name for the picker
  defaultModel: string; // the model used for summaries
  keyPlaceholder: string; // shows the key's typical shape
  keysUrl: string; // where to create a key
}

export const CLOUD_PROVIDER_INFO: Record<CloudProvider, CloudProviderInfo> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    keyPlaceholder: 'AIza…',
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    keyPlaceholder: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-3-5-haiku-latest',
    keyPlaceholder: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
};

export const CLOUD_PROVIDERS: CloudProvider[] = ['gemini', 'openai', 'anthropic'];

export interface CloudModel {
  id: string; // the id passed to the generate API
  label: string; // human-friendly name for the picker
}

/** The model to use for a provider: the user's chosen one, or the provider default. */
export function cloudModelFor(provider: CloudProvider, chosen?: string): string {
  return chosen?.trim() || CLOUD_PROVIDER_INFO[provider].defaultModel;
}

// fetch that turns a network/CORS rejection into a friendly message (fetch only rejects
// on network failure, not on HTTP error status — those are handled via errMessage).
async function cloudFetch(name: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Couldn't reach ${name} — check your connection.`);
  }
}

async function errMessage(name: string, res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return `${name}: invalid or unauthorized API key`;
  if (res.status === 429) return `${name}: rate limited — try again shortly`;
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '');
  } catch {
    // no JSON body
  }
  return `${name} API error ${res.status}${detail ? `: ${detail}` : ''}`;
}

/**
 * List the chat models the user's API key can access, so they can pick one instead of a
 * hardcoded default. Filters each provider's catalog to text-generation-capable models.
 * Throws a friendly Error on a bad key / rate limit / outage.
 */
export async function listModels(provider: CloudProvider, apiKey: string): Promise<CloudModel[]> {
  if (provider === 'gemini') {
    const res = await cloudFetch(
      'Gemini',
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) throw new Error(await errMessage('Gemini', res));
    const data = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({ id: (m.name ?? '').replace(/^models\//, ''), label: m.displayName || (m.name ?? '').replace(/^models\//, '') }))
      .filter((m) => m.id);
  }

  if (provider === 'openai') {
    const res = await cloudFetch('OpenAI', 'https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(await errMessage('OpenAI', res));
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id ?? '')
      .filter((id) => /^(gpt-|o1|o3|o4|chatgpt)/.test(id) && !/embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search/.test(id))
      .sort()
      .map((id) => ({ id, label: id }));
  }

  // anthropic
  const res = await cloudFetch('Claude', 'https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!res.ok) throw new Error(await errMessage('Claude', res));
  const data = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  return (data.data ?? []).map((m) => ({ id: m.id ?? '', label: m.display_name || (m.id ?? '') })).filter((m) => m.id);
}

/**
 * Generate a completion from a cloud provider using the user's own API key. Runs a
 * single non-streaming request (independent HTTP calls, so no GPU-context serialization
 * is needed, unlike WebLLM). Throws a friendly Error on a bad key / rate limit / outage.
 */
export async function cloudGenerate(
  provider: CloudProvider,
  apiKey: string,
  model: string,
  messages: CloudMsg[],
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const temperature = opts?.temperature ?? 0.4;
  const maxTokens = opts?.maxTokens ?? 640;
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (provider === 'gemini') {
    const body: Record<string, unknown> = {
      contents: nonSystem.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await cloudFetch(
      'Gemini',
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error(await errMessage('Gemini', res));
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || '';
      // Give the RIGHT remedy per reason: a SAFETY/blocked response isn't fixed by switching
      // models; a MAX_TOKENS one (a "thinking" model spending its budget) is. Anything else
      // gets a generic retry hint.
      const blocked = /SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(reason);
      const remedy = blocked
        ? 'the content was blocked by the provider\u2019s safety filters — try a different story.'
        : /MAX_TOKENS|LENGTH/i.test(reason)
          ? 'try a non-thinking model (e.g. gemini-2.0-flash) or a shorter thread.'
          : 'try again, or a different model.';
      throw new Error(`Gemini returned no text${reason ? ` (${reason})` : ''}. ${remedy}`);
    }
    return text;
  }

  if (provider === 'openai') {
    // Reasoning models (o1/o3/o4...) reject `max_tokens` (need `max_completion_tokens`) and
    // any non-default `temperature`, and they spend tokens on hidden reasoning — so give them
    // token headroom and omit temperature. Regular gpt-* models take the normal params.
    const reasoning = /^o\d/.test(model);
    const body: Record<string, unknown> = reasoning
      ? { model, messages, max_completion_tokens: Math.max(maxTokens, 4096) }
      : { model, messages, temperature, max_tokens: maxTokens };
    const res = await cloudFetch('OpenAI', 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errMessage('OpenAI', res));
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error(`OpenAI returned no text${data.choices?.[0]?.finish_reason ? ` (${data.choices[0].finish_reason})` : ''}.`);
    return text;
  }

  // anthropic
  const res = await cloudFetch('Claude', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || undefined,
      messages: nonSystem.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(await errMessage('Claude', res));
  const data = (await res.json()) as { content?: Array<{ text?: string }>; stop_reason?: string };
  const text = (data.content ?? []).map((b) => b.text ?? '').join('').trim();
  if (!text) throw new Error(`Claude returned no text${data.stop_reason ? ` (${data.stop_reason})` : ''}.`);
  return text;
}
