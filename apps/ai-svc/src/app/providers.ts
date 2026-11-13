import type {
  AiProviderId,
  ModelInfo,
  ProviderValidationResult,
} from '@org/contracts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  provider: AiProviderId;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

const DEFAULT_BASE: Record<AiProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/inference/openai/v1',
  ollama: 'http://127.0.0.1:11434',
};

const RECOMMENDED: Record<AiProviderId, RegExp> = {
  openai: /^(gpt-4o|gpt-4\.1|gpt-5|o[34])/i,
  anthropic: /^claude-(sonnet|opus|haiku)-(4|3\.7)/i,
  google: /^gemini-2\.[05]-(pro|flash)$/i,
  openrouter: /(claude-sonnet-4|gpt-5|gemini-2\.5-pro|deepseek)/i,
  opencode:
    /^(claude-sonnet-5|gpt-(6\.1-sol|5\.4-mini)|gemini-3\.8-flash|deepseek-v4\.1-flash)$/i,
  ollama: /(coder|qwen|llama3|deepseek)/i,
};

function baseOf(provider: AiProviderId, baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_BASE[provider]).replace(/\/+$/, '');
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof body.error === 'string') {
      return body.error;
    }
    return body.error?.message ?? body.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status} ${response.statusText}`;
  }
}

/**
 * `fetch` rejects with a bare "fetch failed" for connection problems, which is
 * useless in the UI. Add the host and the underlying reason.
 */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : String(error);
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      // keep the raw url
    }
    throw new Error(
      `Could not reach ${origin} (${cause}). Check the base URL, that the service is running, and your network connection.`,
    );
  }
}

function toModel(
  provider: AiProviderId,
  id: string,
  label?: string,
  options: { free?: boolean; contextWindow?: number } = {},
): ModelInfo {
  return {
    id,
    label: label?.trim() || id,
    provider,
    recommended: RECOMMENDED[provider].test(id),
    ...(options.free ? { free: true } : {}),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  };
}

export async function validateProvider(input: {
  provider: AiProviderId;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ProviderValidationResult> {
  const base = baseOf(input.provider, input.baseUrl);
  const key = input.apiKey?.trim();

  try {
    switch (input.provider) {
      case 'openai': {
        if (!key) {
          return { ok: false, message: 'An API key is required.', models: [] };
        }
        const response = await safeFetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!response.ok) {
          return { ok: false, message: await readError(response), models: [] };
        }
        const body = (await response.json()) as { data?: { id: string }[] };
        const models = (body.data ?? [])
          .filter((model) => !/embedding|tts|whisper|dall-e|moderation/i.test(model.id))
          .map((model) => toModel('openai', model.id))
          .sort(sortModels)
          .slice(0, 60);
        return {
          ok: true,
          message: `Connected. ${models.length} models available.`,
          models,
        };
      }

      case 'anthropic': {
        if (!key) {
          return { ok: false, message: 'An API key is required.', models: [] };
        }
        const response = await safeFetch(`${base}/models?limit=100`, {
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
        });
        if (!response.ok) {
          return { ok: false, message: await readError(response), models: [] };
        }
        const body = (await response.json()) as {
          data?: { id: string; display_name?: string }[];
        };
        const models = (body.data ?? [])
          .map((model) => toModel('anthropic', model.id, model.display_name))
          .sort(sortModels)
          .slice(0, 40);
        return {
          ok: true,
          message: `Connected. ${models.length} models available.`,
          models,
        };
      }

      case 'google': {
        if (!key) {
          return { ok: false, message: 'An API key is required.', models: [] };
        }
        const response = await safeFetch(
          `${base}/models?key=${encodeURIComponent(key)}&pageSize=100`,
        );
        if (!response.ok) {
          return { ok: false, message: await readError(response), models: [] };
        }
        const body = (await response.json()) as {
          models?: {
            name: string;
            displayName?: string;
            supportedGenerationMethods?: string[];
          }[];
        };
        const models = (body.models ?? [])
          .filter((model) =>
            (model.supportedGenerationMethods ?? []).includes('generateContent'),
          )
          .map((model) =>
            toModel(
              'google',
              model.name.replace(/^models\//, ''),
              model.displayName,
            ),
          )
          .sort(sortModels)
          .slice(0, 40);
        return {
          ok: true,
          message: `Connected. ${models.length} models available.`,
          models,
        };
      }

      case 'openrouter': {
        if (!key) {
          return { ok: false, message: 'An API key is required.', models: [] };
        }
        const keyResponse = await safeFetch(`${base}/key`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!keyResponse.ok) {
          return { ok: false, message: await readError(keyResponse), models: [] };
        }
        const keyBody = (await keyResponse.json()) as {
          data?: { label?: string };
        };
        const listResponse = await safeFetch(`${base}/models`);
        const listBody = listResponse.ok
          ? ((await listResponse.json()) as {
              data?: { id: string; name?: string }[];
            })
          : { data: [] };
        const models = (listBody.data ?? [])
          .map((model) =>
            toModel('openrouter', model.id, model.name, {
              free: /:free$/i.test(model.id),
            }),
          )
          .sort(sortModels)
          // Keep enough headroom that every free model survives the slice.
          .slice(0, 160);
        return {
          ok: true,
          message: `Connected as ${keyBody.data?.label ?? 'OpenRouter user'}.`,
          models,
          accountLabel: keyBody.data?.label,
        };
      }

      case 'opencode': {
        if (!key) {
          return { ok: false, message: 'An API key is required.', models: [] };
        }
        const response = await safeFetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!response.ok) {
          return { ok: false, message: await readError(response), models: [] };
        }
        const body = (await response.json()) as {
          data?: {
            id: string;
            name?: string;
            type?: string;
            limit?: { context?: number };
          }[];
        };
        const models = (body.data ?? [])
          .filter((model) => !model.type || model.type === 'chat')
          // Free-tier models only work from inside OpenCode, so they would
          // always fail here. Hide them rather than offer a dead model.
          .filter(
            (model) => model.id !== 'big-pickle' && !/-free$/i.test(model.id),
          )
          .map((model) => ({
            ...toModel('opencode', model.id, model.name, {
              contextWindow: model.limit?.context,
            }),
          }))
          .sort(sortModels)
          .slice(0, 120);
        if (models.length === 0) {
          return {
            ok: false,
            message:
              'The key works, but no paid models are enabled for this workspace. Enable one in the OpenCode console.',
            models: [],
          };
        }
        return {
          ok: true,
          message: `Connected. ${models.length} models available.`,
          models,
        };
      }

      case 'ollama': {
        const response = await safeFetch(`${base}/api/tags`);
        if (!response.ok) {
          return {
            ok: false,
            message: `Ollama is not reachable at ${base}. Start it with "ollama serve".`,
            models: [],
          };
        }
        const body = (await response.json()) as {
          models?: { name: string }[];
        };
        const models = (body.models ?? [])
          .map((model) => toModel('ollama', model.name, undefined, { free: true }))
          .sort(sortModels);
        return {
          ok: true,
          message: `Connected. ${models.length} local models available.`,
          models,
        };
      }

      default:
        return { ok: false, message: 'Unknown provider.', models: [] };
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Could not reach the provider.',
      models: [],
    };
  }
}

function sortModels(a: ModelInfo, b: ModelInfo): number {
  if (a.recommended !== b.recommended) {
    return a.recommended ? -1 : 1;
  }
  if (a.free !== b.free) {
    return a.free ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export async function chat(request: ChatRequest): Promise<string> {
  const base = baseOf(request.provider, request.baseUrl);
  const temperature = request.temperature ?? 0.1;

  switch (request.provider) {
    case 'openai':
    case 'openrouter':
    case 'opencode': {
      const response = await safeFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey ?? ''}`,
          ...(request.provider === 'openrouter'
            ? { 'HTTP-Referer': 'https://wiki2code.local', 'X-Title': 'Wiki2Code' }
            : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature,
          max_tokens: request.maxTokens ?? 4000,
          // OpenCode Zen translates every model to chat/completions, but not
          // all of them support OpenAI-style structured output.
          ...(request.json && request.provider !== 'opencode'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return body.choices?.[0]?.message?.content ?? '';
    }

    case 'anthropic': {
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const messages = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
        }));
      const response = await safeFetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': request.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: request.model,
          system: system || undefined,
          messages,
          temperature,
          max_tokens: request.maxTokens ?? 4000,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as {
        content?: { type: string; text?: string }[];
      };
      return (body.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
    }

    case 'google': {
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const contents = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        }));
      const response = await safeFetch(
        `${base}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey ?? '')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: {
              temperature,
              maxOutputTokens: request.maxTokens ?? 4000,
              ...(request.json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return (body.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');
    }

    case 'ollama': {
      const response = await safeFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          ...(request.json ? { format: 'json' } : {}),
          options: { temperature },
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as {
        message?: { content?: string };
      };
      return body.message?.content ?? '';
    }

    default:
      throw new Error(`Unsupported provider: ${request.provider}`);
  }
}
