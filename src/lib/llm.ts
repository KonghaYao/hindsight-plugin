/**
 * LLM provider detection for Hindsight's fact extraction.
 *
 * Port of: detectLLMConfig() in index.js
 *
 * When running hindsight-embed locally (daemon mode), it needs an LLM to
 * extract facts from retained conversations. This module detects the LLM
 * config using the same priority chain as Openclaw:
 *
 *   1. HINDSIGHT_API_LLM_* environment variables (highest priority)
 *   2. Plugin config (llmProvider, llmModel, llmApiKeyEnv)
 *   3. Auto-detect from standard provider env vars
 *   4. External API mode (server-side LLM, no local config needed)
 */
import type { PluginConfig } from './config';

interface ProviderEntry {
  name: string;
  keyEnv: string;
}

/** Detected LLM configuration. All fields are null in external API mode, where the server runs the LLM. */
export interface LlmConfig {
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
  source: string;
}

/** Provider detection table — same order as Openclaw. */
const PROVIDER_DETECTION: readonly ProviderEntry[] = [
  { name: 'openai', keyEnv: 'OPENAI_API_KEY' },
  { name: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  { name: 'gemini', keyEnv: 'GEMINI_API_KEY' },
  { name: 'groq', keyEnv: 'GROQ_API_KEY' },
  { name: 'ollama', keyEnv: '' },
  { name: 'openai-codex', keyEnv: '' },
  { name: 'claude-code', keyEnv: '' },
  { name: 'cursor', keyEnv: '' },
  { name: 'github-copilot', keyEnv: '' },
];

/** Providers that don't require an API key. */
const NO_KEY_REQUIRED = new Set([
  'ollama',
  'openai-codex',
  'claude-code',
  'cursor',
  'github-copilot',
]);

/** Find a provider entry by name. */
function findProvider(name: string): ProviderEntry | null {
  return PROVIDER_DETECTION.find((provider) => provider.name === name) ?? null;
}

/**
 * Detect LLM configuration.
 *
 * Returns the provider, api key, model, base url and the source the values came
 * from. Returns null values for external API mode (server handles LLM). Throws
 * if no configuration is found and the plugin is not in external API mode.
 */
export function detectLlmConfig(config: PluginConfig): LlmConfig {
  const overrideProvider = process.env.HINDSIGHT_API_LLM_PROVIDER ?? null;
  const overrideModel = process.env.HINDSIGHT_API_LLM_MODEL ?? null;
  const overrideKey = process.env.HINDSIGHT_API_LLM_API_KEY ?? null;
  const overrideBaseUrl = process.env.HINDSIGHT_API_LLM_BASE_URL ?? null;

  // Priority 1: HINDSIGHT_API_LLM_PROVIDER env var
  if (overrideProvider) {
    if (!overrideKey && !NO_KEY_REQUIRED.has(overrideProvider)) {
      throw new Error(
        `HINDSIGHT_API_LLM_PROVIDER is set to "${overrideProvider}" but HINDSIGHT_API_LLM_API_KEY is not set.`,
      );
    }
    return {
      provider: overrideProvider,
      apiKey: overrideKey || '',
      model: overrideModel,
      baseUrl: overrideBaseUrl,
      source: 'HINDSIGHT_API_LLM_PROVIDER override',
    };
  }

  // Priority 2: Plugin config llmProvider/llmModel
  const cfgProvider = config.llmProvider ?? null;
  if (cfgProvider) {
    const pinfo = findProvider(cfgProvider);
    let apiKey = '';
    const keyEnvName = config.llmApiKeyEnv ?? null;
    if (keyEnvName) {
      apiKey = process.env[keyEnvName] ?? '';
    } else if (pinfo?.keyEnv) {
      apiKey = process.env[pinfo.keyEnv] ?? '';
    }

    if (!apiKey && !NO_KEY_REQUIRED.has(cfgProvider)) {
      const keySource = keyEnvName || (pinfo ? pinfo.keyEnv : 'unknown');
      throw new Error(
        `Plugin config llmProvider is "${cfgProvider}" but no API key found. Expected env var: ${keySource}`,
      );
    }
    return {
      provider: cfgProvider,
      apiKey,
      model: config.llmModel || overrideModel,
      baseUrl: overrideBaseUrl,
      source: 'plugin config',
    };
  }

  // Priority 3: Auto-detect from standard provider env vars
  for (const pinfo of PROVIDER_DETECTION) {
    if (NO_KEY_REQUIRED.has(pinfo.name)) {
      continue; // Must be explicitly requested
    }
    if (!pinfo.keyEnv) {
      continue;
    }
    const apiKey = process.env[pinfo.keyEnv] ?? '';
    if (apiKey) {
      return {
        provider: pinfo.name,
        apiKey,
        model: overrideModel,
        baseUrl: overrideBaseUrl,
        source: `auto-detected from ${pinfo.keyEnv}`,
      };
    }
  }

  // Priority 4: External API mode — server handles LLM
  if (config.hindsightApiUrl) {
    return {
      provider: null,
      apiKey: null,
      model: null,
      baseUrl: null,
      source: 'external-api-mode-no-llm',
    };
  }

  throw new Error(
    'No LLM configuration found for Hindsight.\n\n' +
      'Option 1: Set a standard provider API key (auto-detect):\n' +
      '  export OPENAI_API_KEY=sk-your-key\n' +
      '  export ANTHROPIC_API_KEY=your-key\n\n' +
      'Option 2: Override with Hindsight-specific env vars:\n' +
      '  export HINDSIGHT_API_LLM_PROVIDER=openai\n' +
      '  export HINDSIGHT_API_LLM_API_KEY=sk-your-key\n\n' +
      'Option 3: Use an external Hindsight API (server-side LLM):\n' +
      '  Set hindsightApiUrl in settings.json or HINDSIGHT_API_URL env var\n\n' +
      'The model will be selected automatically by Hindsight. To override: export HINDSIGHT_API_LLM_MODEL=your-model',
  );
}

/**
 * Build environment variables for the hindsight-embed daemon from LLM config.
 *
 * These are passed to the daemon subprocess so it knows which LLM to use for
 * fact extraction.
 */
export function getLlmEnvVars(llmConfig: LlmConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (llmConfig.provider) {
    env.HINDSIGHT_API_LLM_PROVIDER = llmConfig.provider;
  }
  if (llmConfig.apiKey) {
    env.HINDSIGHT_API_LLM_API_KEY = llmConfig.apiKey;
  }
  if (llmConfig.model) {
    env.HINDSIGHT_API_LLM_MODEL = llmConfig.model;
  }
  if (llmConfig.baseUrl) {
    env.HINDSIGHT_API_LLM_BASE_URL = llmConfig.baseUrl;
  }
  return env;
}
