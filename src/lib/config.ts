/**
 * Configuration management for the Hindsight plugin.
 *
 * Loads settings from settings.json (plugin defaults, then the user's stable
 * config) merged with environment variable overrides. Mirrors the config schema
 * of the Openclaw plugin.
 */
import { readFileSync } from 'node:fs';
import { pluginSettingsPath, userConfigPath } from './paths';

/** Every setting the plugin understands. Unknown keys from settings files are preserved but untyped. */
export interface PluginConfig {
  // Recall
  autoRecall: boolean;
  recallBudget: string;
  recallMaxTokens: number;
  recallTypes: string[];
  recallContextTurns: number;
  recallMaxQueryChars: number;
  recallRoles: string[];
  recallTags: string[];
  recallTagsMatch: string;
  recallTagGroups: unknown;
  recallAdditionalBankFilters: Record<string, unknown>;
  recallAdditionalBanks: string[];
  recallMinScores: Record<string, unknown>;
  recallPromptPreamble: string;
  // Retain
  autoRetain: boolean;
  retainMode: string;
  retainRoles: string[];
  retainEveryNTurns: number;
  retainOverlapTurns: number;
  retainToolCalls: boolean;
  retainContext: string;
  retainTags: string[];
  retainMetadata: Record<string, unknown>;
  // Connection
  upgradeNotice: boolean;
  hindsightApiUrl: string | null;
  hindsightApiToken: string | null;
  apiPort: number;
  daemonIdleTimeout: number;
  embedVersion: string;
  embedPackagePath: string | null;
  requestTimeoutSeconds: number | null;
  // Bank
  bankId: string | null;
  bankIdPrefix: string;
  dynamicBankId: boolean;
  dynamicBankGranularity: string[];
  bankMission: string;
  retainMission: string | null;
  agentName: string;
  resolveWorktrees: boolean;
  directoryBankMap: Record<string, string>;
  // LLM (daemon mode)
  llmProvider: string | null;
  llmModel: string | null;
  llmApiKeyEnv: string | null;
  // Misc
  enableKnowledgeTools: boolean;
  debug: boolean;

  [key: string]: unknown;
}

/** Built-in defaults. Settings files and env vars layer on top of these. */
export const DEFAULTS: PluginConfig = {
  // Recall
  autoRecall: true,
  recallBudget: 'mid',
  recallMaxTokens: 1024,
  // All three fact types the API knows. Leaving out `world`/`experience` (the
  // server's own default) hides freshly retained content until consolidation
  // synthesises an observation — and drops it for good when it synthesises none,
  // which it sometimes does. Naming all three also keeps the result identical to
  // sending no filter at all, rather than depending on that undocumented default.
  recallTypes: ['world', 'experience', 'observation'],
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  recallRoles: ['user', 'assistant'],
  recallTags: [],
  recallTagsMatch: 'any',
  recallTagGroups: null,
  recallAdditionalBankFilters: {},
  recallAdditionalBanks: [],
  recallMinScores: {},
  recallPromptPreamble:
    'Relevant memories from past conversations (prioritize recent when ' +
    'conflicting). Only use memories that are directly useful to continue ' +
    'this conversation; ignore the rest:',
  // Retain
  autoRetain: true,
  retainMode: 'full-session',
  retainRoles: ['user', 'assistant'],
  retainEveryNTurns: 10,
  retainOverlapTurns: 2,
  retainToolCalls: false,
  retainContext: 'claude-code',
  retainTags: [],
  retainMetadata: {},
  // Connection
  upgradeNotice: true, // show the superseded-by-coding-agents notice (capped, see lib/upgrade-notice.ts)
  hindsightApiUrl: null,
  hindsightApiToken: null,
  apiPort: 9077,
  daemonIdleTimeout: 0,
  embedVersion: 'latest',
  embedPackagePath: null,
  requestTimeoutSeconds: null,
  // Bank
  bankId: null,
  bankIdPrefix: '',
  dynamicBankId: false,
  dynamicBankGranularity: ['agent', 'project'],
  bankMission: '',
  retainMission: null,
  agentName: 'claude-code',
  resolveWorktrees: true,
  directoryBankMap: {},
  // LLM (for daemon mode)
  llmProvider: null,
  llmModel: null,
  llmApiKeyEnv: null,
  // Misc
  enableKnowledgeTools: true,
  debug: false,
};

/** Env var name → config key and the type it must be cast to. */
const ENV_OVERRIDES: Record<string, { key: keyof PluginConfig; type: EnvType }> = {
  HINDSIGHT_API_URL: { key: 'hindsightApiUrl', type: 'string' },
  HINDSIGHT_API_TOKEN: { key: 'hindsightApiToken', type: 'string' },
  HINDSIGHT_BANK_ID: { key: 'bankId', type: 'string' },
  HINDSIGHT_AGENT_NAME: { key: 'agentName', type: 'string' },
  HINDSIGHT_AUTO_RECALL: { key: 'autoRecall', type: 'bool' },
  HINDSIGHT_AUTO_RETAIN: { key: 'autoRetain', type: 'bool' },
  HINDSIGHT_RETAIN_MODE: { key: 'retainMode', type: 'string' },
  HINDSIGHT_RECALL_BUDGET: { key: 'recallBudget', type: 'string' },
  HINDSIGHT_RECALL_MAX_TOKENS: { key: 'recallMaxTokens', type: 'int' },
  HINDSIGHT_RECALL_MAX_QUERY_CHARS: { key: 'recallMaxQueryChars', type: 'int' },
  HINDSIGHT_RECALL_CONTEXT_TURNS: { key: 'recallContextTurns', type: 'int' },
  HINDSIGHT_RECALL_TAGS: { key: 'recallTags', type: 'list' },
  HINDSIGHT_RECALL_TAGS_MATCH: { key: 'recallTagsMatch', type: 'string' },
  HINDSIGHT_RECALL_TAG_GROUPS: { key: 'recallTagGroups', type: 'dict' },
  HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS: { key: 'recallAdditionalBankFilters', type: 'dict' },
  HINDSIGHT_API_PORT: { key: 'apiPort', type: 'int' },
  HINDSIGHT_DAEMON_IDLE_TIMEOUT: { key: 'daemonIdleTimeout', type: 'int' },
  HINDSIGHT_REQUEST_TIMEOUT_SECONDS: { key: 'requestTimeoutSeconds', type: 'int' },
  HINDSIGHT_EMBED_VERSION: { key: 'embedVersion', type: 'string' },
  HINDSIGHT_EMBED_PACKAGE_PATH: { key: 'embedPackagePath', type: 'string' },
  HINDSIGHT_DYNAMIC_BANK_ID: { key: 'dynamicBankId', type: 'bool' },
  HINDSIGHT_BANK_MISSION: { key: 'bankMission', type: 'string' },
  HINDSIGHT_LLM_PROVIDER: { key: 'llmProvider', type: 'string' },
  HINDSIGHT_LLM_MODEL: { key: 'llmModel', type: 'string' },
  HINDSIGHT_DEBUG: { key: 'debug', type: 'bool' },
};

type EnvType = 'string' | 'bool' | 'int' | 'list' | 'dict';

const TRUE_VALUES = new Set(['true', '1', 'yes']);

/**
 * Cast an environment variable string to the target type.
 * Returns null when the value cannot be represented, which skips the override
 * (mirrors the Python `_cast_env` contract).
 */
export function castEnv(value: string, type: EnvType): unknown {
  switch (type) {
    case 'bool':
      return TRUE_VALUES.has(value.toLowerCase());
    case 'int': {
      // Python's int() rejects floats and trailing junk; match that strictly.
      const trimmed = value.trim();
      if (!/^[+-]?\d+$/.test(trimmed)) {
        return null;
      }
      return Number.parseInt(trimmed, 10);
    }
    case 'list': {
      const parsed = tryParseJson(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed === undefined) {
        // Not JSON at all — accept a comma-separated list.
        return value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
      return null;
    }
    case 'dict': {
      const parsed = tryParseJson(value);
      // Mirrors `isinstance(parsed, (dict, list))` — either container is accepted.
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
        return parsed;
      }
      return null;
    }
    default:
      return value;
  }
}

/** Parse JSON, returning undefined when the text is not valid JSON. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Merge a settings.json file into the config in place. Missing files are ignored. */
function loadSettingsFile(path: string, config: PluginConfig): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // Missing or unreadable — nothing to merge.
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // Null means "unset" — never let it clobber a default.
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    }
  } catch (error) {
    debugLog(config, `Failed to load ${path}: ${String(error)}`);
  }
}

/**
 * Load plugin configuration from settings.json plus env overrides.
 *
 * Loading order (later entries win):
 *   1. Built-in defaults
 *   2. Plugin settings.json      (CLAUDE_PLUGIN_ROOT/settings.json)
 *   3. User config               (~/.hindsight/claude-code.json)
 *   4. Environment variable overrides
 */
export function loadConfig(): PluginConfig {
  const config: PluginConfig = { ...DEFAULTS };

  loadSettingsFile(pluginSettingsPath(), config);
  loadSettingsFile(userConfigPath(), config);

  for (const [envName, { key, type }] of Object.entries(ENV_OVERRIDES)) {
    const raw = process.env[envName];
    if (raw === undefined) {
      continue;
    }
    const cast = castEnv(raw, type);
    if (cast !== null) {
      config[key] = cast;
    }
  }

  return config;
}

/** Log to stderr when debug mode is enabled. */
export function debugLog(config: PluginConfig, ...args: unknown[]): void {
  if (config.debug) {
    console.error('[Hindsight]', ...args);
  }
}
