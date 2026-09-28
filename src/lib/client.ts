/**
 * Hindsight REST API client.
 *
 * Communicates with a Hindsight server via HTTP. Mirrors the HTTP mode of the
 * Openclaw HindsightClient (client.js), adapted for Node's global fetch.
 */
import { pluginVersion } from './paths';

export const DEFAULT_TIMEOUT = 15; // seconds

/**
 * Sent on every request so self-hosted deployments behind Cloudflare (or any
 * reverse proxy with UA-based bot filtering) don't block the client — the
 * Python original's stdlib default "Python-urllib/X.Y" tripped Cloudflare error
 * 1010, so the UA is always set explicitly.
 */
export const USER_AGENT = `hindsight-claude-code/${pluginVersion()}`;

/** Validate and normalize the API URL. Reject non-HTTP schemes. */
export function validateApiUrl(url: string): string {
  const parsed = splitUrl(url);
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    throw new Error(`Hindsight API URL must use http or https, got: '${parsed.scheme}'`);
  }
  if (!parsed.hostname) {
    throw new Error(`Hindsight API URL has no hostname: '${url}'`);
  }
  return url.replace(/\/+$/, '');
}

/**
 * The slice of `urllib.parse.urlparse` this module relies on: scheme + hostname.
 *
 * Hand-rolled rather than `new URL()`, which throws its own TypeError for an
 * unusable URL and so cannot tell "ftp://host" apart from "http://" — the two
 * inputs the original rejects with different messages.
 */
function splitUrl(url: string): { scheme: string; hostname: string | null } {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  const scheme = (schemeMatch?.[1] ?? '').toLowerCase();
  const rest = url.slice((schemeMatch?.[0] ?? '').length);
  if (!rest.startsWith('//')) {
    return { scheme, hostname: null };
  }

  // Authority = up to the path/query/fragment, minus any userinfo.
  const authority = rest.slice(2).split(/[/?#]/)[0] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);

  let host: string;
  if (hostPort.startsWith('[')) {
    // Bracketed IPv6 literal — the hostname is what sits between the brackets.
    const end = hostPort.indexOf(']');
    host = end === -1 ? hostPort.slice(1) : hostPort.slice(1, end);
  } else {
    // Everything before the first colon is the host; the rest is the port.
    const colon = hostPort.indexOf(':');
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  }

  const hostname = host.toLowerCase();
  return { scheme, hostname: hostname === '' ? null : hostname };
}

/** HTTP client for the Hindsight API. */
export class HindsightClient {
  readonly apiUrl: string;
  readonly apiToken: string | null;
  readonly requestTimeoutOverride: number | null;

  constructor(
    apiUrl: string,
    apiToken: string | null = null,
    requestTimeoutOverride: number | null = null,
  ) {
    this.apiUrl = validateApiUrl(apiUrl);
    this.apiToken = apiToken;
    this.requestTimeoutOverride = requestTimeoutOverride;
  }

  /** Return the override if configured, otherwise the caller's timeout. */
  private resolveTimeout(timeout: number): number {
    return this.requestTimeoutOverride !== null ? this.requestTimeoutOverride : timeout;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    return headers;
  }

  /**
   * Send a request and return the decoded JSON body.
   *
   * `body` follows the original's `if body:` rule, so an empty object is sent
   * without a payload. Non-2xx responses raise `HTTP {status} from {url}:
   * {body}` — the hooks match on that shape.
   */
  async request(
    method: string,
    path: string,
    body: Record<string, unknown> | null = null,
    timeout: number = DEFAULT_TIMEOUT,
  ): Promise<Record<string, unknown>> {
    const resolvedTimeout = this.resolveTimeout(timeout);
    const url = `${this.apiUrl}${path}`;
    const hasBody = body !== null && Object.keys(body).length > 0;
    const response = await fetch(url, {
      method,
      headers: this.headers(),
      body: hasBody ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(resolvedTimeout * 1000),
    });

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // The error body was unreadable — report the status alone.
      }
      throw new Error(`HTTP ${response.status} from ${url}: ${bodyText}`);
    }

    const parsed: unknown = await response.json();
    return parsed as Record<string, unknown>;
  }

  /**
   * Recall memories from a bank.
   *
   * Returns the raw API response dict with 'results' list.
   */
  async recall(
    bankId: string,
    query: string,
    maxTokens: number = 1024,
    budget: string = 'mid',
    types: string[] | null = null,
    tags: string[] | null = null,
    tagsMatch: string | null = null,
    tagGroups: unknown = null,
    timeout: number = 10,
  ): Promise<Record<string, unknown>> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    const body: Record<string, unknown> = {
      query,
      max_tokens: maxTokens,
    };
    if (budget) {
      body.budget = budget;
    }
    if (types) {
      body.types = types;
    }
    if (tags) {
      body.tags = tags;
    }
    if (tagsMatch) {
      body.tags_match = tagsMatch;
    }
    if (tagGroups) {
      body.tag_groups = tagGroups;
    }
    return this.request('POST', path, body, timeout);
  }

  /**
   * Retain content into a bank's memory.
   *
   * Posts with async=true so the server processes in the background. The
   * context field helps Hindsight cluster memories by provenance (e.g.
   * "claude-code" vs manual retains).
   */
  async retain(
    bankId: string,
    content: string,
    documentId: string = 'conversation',
    context: string | null = null,
    metadata: Record<string, unknown> | null = null,
    tags: string[] | null = null,
    timeout: number = 15,
  ): Promise<Record<string, unknown>> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      document_id: documentId,
      metadata: metadata ?? {},
    };
    if (context) {
      item.context = context;
    }
    if (tags) {
      item.tags = tags;
    }
    const body: Record<string, unknown> = {
      items: [item],
      async: true,
    };
    return this.request('POST', path, body, timeout);
  }

  /**
   * Set the mission/persona for a bank.
   *
   * Uses PATCH /banks/{id}/config with reflect_mission and retain_mission. The
   * old PUT /banks/{id} with 'mission' field is deprecated in v0.4.19.
   */
  async setBankMission(
    bankId: string,
    mission: string,
    retainMission: string | null = null,
    timeout: number = 15,
  ): Promise<Record<string, unknown>> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/config`;
    const updates: Record<string, unknown> = { reflect_mission: mission };
    if (retainMission) {
      updates.retain_mission = retainMission;
    }
    return this.request('PATCH', path, { updates }, timeout);
  }
}
