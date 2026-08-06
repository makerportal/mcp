/**
 * Everything the bridge does that is not "talk to stdio", with no dependencies
 * at all — not even the MCP SDK.
 *
 * TWO REASONS THIS FILE EXISTS SEPARATELY FROM `bridge.mjs`.
 *
 * 1. **It contains no solver source, and neither does anything else here.**
 *    This package is a transport shim. Every number it ever returns was
 *    computed on makerportal.ai by the same function that renders the published
 *    page. There is deliberately no filter design, no eigenmode solve and no
 *    VRAM arithmetic anywhere in `packages/mcp-client/` — a local copy would be
 *    a second implementation that answers differently from the site the moment
 *    either side changes, and the caller would have no way to know which one
 *    they got. `boundary.test.mjs` packs the package and greps every packed
 *    byte for solver symbols; that test is the enforcement, this comment is
 *    only the reason.
 *
 * 2. **It is testable without installing anything.** The repo's `npm test`
 *    runs from the repo root, which does not depend on
 *    `@modelcontextprotocol/sdk`. Keeping the SDK import confined to
 *    `bridge.mjs` means the logic that decides what URL to call, what headers
 *    to send, and what a given HTTP status means is covered by tests that run
 *    everywhere, every time.
 *
 * NOTHING HERE LOGS A CREDENTIAL. `MAKERPORTAL_LICENSE_KEY` is read, turned
 * into an `Authorization` header, and never printed, never included in an error
 * message, and never written to a file. `redactHeaders()` is what the error
 * paths use.
 */

/** The public endpoint. Apex — Vercel 308s `www` away, so `www` is a redirect. */
export const DEFAULT_ENDPOINT = 'https://makerportal.ai/api/mcp';

/**
 * Protocol revision this client speaks.
 *
 * The bridge negotiates for real during `initialize`; this is the value sent on
 * the `MCP-Protocol-Version` header of later requests before a negotiated one
 * is known.
 */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

/** A cold serverless start plus a solve. Generous, but not unbounded. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Where to POST.
 *
 * `MAKERPORTAL_API_URL` exists for development against a local `astro dev`
 * server; the default is the production endpoint, so the zero-config path is
 * the one that works.
 */
export function resolveEndpoint(env = process.env) {
  const override = env.MAKERPORTAL_API_URL;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return DEFAULT_ENDPOINT;
}

/**
 * The headers for one POST.
 *
 * `Accept` names both media types because the streamable-HTTP specification
 * requires a client to be willing to read either — this server always answers
 * with `application/json`, but announcing only that would make this client
 * non-conformant against any other server someone points it at.
 *
 * The license key is optional and the keyless path is the default: the free
 * tier needs no configuration at all.
 */
export function buildHeaders(env = process.env, protocolVersion = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (typeof protocolVersion === 'string' && protocolVersion !== '') {
    headers['MCP-Protocol-Version'] = protocolVersion;
  }
  const key = env.MAKERPORTAL_LICENSE_KEY;
  if (typeof key === 'string' && key.trim() !== '') {
    headers.Authorization = `Bearer ${key.trim()}`;
  }
  return headers;
}

/**
 * Headers safe to put in an error message.
 *
 * A transport failure is exactly when someone pastes the whole error into an
 * issue, and `Authorization` must not be in it.
 */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = name.toLowerCase() === 'authorization' ? '<redacted>' : value;
  }
  return out;
}

export function jsonRpcRequest(id, method, params) {
  const message = { jsonrpc: '2.0', id, method };
  if (params !== undefined) message.params = params;
  return message;
}

/**
 * An error carrying a JSON-RPC code, so `bridge.mjs` can re-raise it as an
 * `McpError` with the code the server chose.
 *
 * The server's `-32602` bodies carry `data.valid` — every accepted value for an
 * enumerated parameter. That list is the thing that lets an agent fix its own
 * call on the next attempt, so it is carried through rather than flattened into
 * a sentence.
 */
export class RemoteRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RemoteRpcError';
    this.code = code;
    this.data = data;
  }
}

/** A failure to speak to the endpoint at all: DNS, TLS, timeout, 404, 500. */
export class TransportError extends Error {
  constructor(message, { status = null, endpoint = null } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/**
 * Turn one HTTP response into a JSON-RPC result, or throw something a human can
 * act on.
 *
 * The status codes are meanings, not numbers:
 *  - 202 is a notification acknowledged. There is no body and no result.
 *  - 405 means the endpoint answered but does not take POST — almost always a
 *    URL pointed at a page instead of at `/api/mcp`.
 *  - 404 against the production host, before the npm package is published, is
 *    availability rather than a defect; against a dev server it means the route
 *    is not built. The message says both because the user knows which they are.
 */
export function interpretResponse({ status, contentType, text, endpoint }) {
  if (status === 202) return { kind: 'accepted' };

  if (status === 405) {
    throw new TransportError(
      `${endpoint} refused POST (405). That URL is not an MCP endpoint — it should end in /api/mcp.`,
      { status, endpoint },
    );
  }
  if (status === 404) {
    throw new TransportError(
      `${endpoint} returned 404. Check MAKERPORTAL_API_URL; a dev server must be running for a localhost URL.`,
      { status, endpoint },
    );
  }
  if (status === 403) {
    throw new TransportError(
      `${endpoint} returned 403. Astro rejects a non-GET request that carries no Content-Type; this client always sends application/json, so a 403 here means something between you and the server stripped it.`,
      { status, endpoint },
    );
  }

  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/event-stream')) {
    throw new TransportError(
      `${endpoint} answered with an SSE stream. This client speaks the single-JSON-response mode of streamable HTTP only, and makerportal.ai never streams.`,
      { status, endpoint },
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TransportError(
      `${endpoint} returned ${status} with a body that is not JSON: ${truncate(text, 200)}`,
      { status, endpoint },
    );
  }

  if (Array.isArray(body)) {
    throw new TransportError(`${endpoint} answered a single request with a batch.`, { status, endpoint });
  }

  if (body !== null && typeof body === 'object' && body.error) {
    throw new RemoteRpcError(
      typeof body.error.code === 'number' ? body.error.code : -32603,
      typeof body.error.message === 'string' ? body.error.message : `Request failed with HTTP ${status}.`,
      body.error.data,
    );
  }

  if (status < 200 || status >= 300) {
    throw new TransportError(`${endpoint} returned HTTP ${status}: ${truncate(text, 200)}`, { status, endpoint });
  }

  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new TransportError(`${endpoint} returned a JSON-RPC message with neither result nor error.`, {
      status,
      endpoint,
    });
  }

  return { kind: 'result', result: body.result };
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text : String(text);
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * POST one JSON-RPC message and interpret the answer.
 *
 * `fetchImpl` is an argument so the whole path is testable without a network or
 * a server. Production passes nothing and gets the global `fetch`.
 */
export async function postRpc({
  endpoint,
  headers,
  message,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TransportError(`Could not reach ${endpoint}: ${reason}`, { endpoint });
  }

  const text = await response.text();
  return interpretResponse({
    status: response.status,
    contentType: response.headers.get('content-type'),
    text,
    endpoint,
  });
}
