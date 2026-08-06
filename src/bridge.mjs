/**
 * The stdio ⇄ HTTP bridge.
 *
 * An MCP client (Claude Code, Cursor, ChatGPT's connector UI) launches this as
 * a child process and speaks JSON-RPC over stdin/stdout. makerportal.ai speaks
 * stateless streamable HTTP. This file is the only thing in between, and it
 * holds NO ANSWERS OF ITS OWN: `tools/list` and `tools/call` are forwarded and
 * their results returned unchanged.
 *
 * That is the whole design constraint. If this file ever grew a cached tool
 * list, a local schema, a "helpful" default argument or a fallback answer for
 * when the network is down, the package would start disagreeing with the site
 * it is a client for — and the caller would have no way to tell which of the
 * two they were reading. There is exactly one exception, and it is not an
 * answer: `initialize` is fetched from the server ONCE at startup so the tool
 * instructions and the version this bridge reports are the server's own.
 *
 * WHY THE SDK IS USED HERE AND NOT ON THE SERVER. `McpServer` +
 * `StdioServerTransport` are exactly right for a Node child process: framing,
 * initialization, error shapes, all of it maintained upstream. Its HTTP server
 * transports are the ones that do not fit an Astro endpoint (Node
 * `req`/`res` versus WHATWG `Request`/`Response`), which is why
 * `src/lib/mcp/server.ts` on the site side is hand-rolled instead.
 *
 * WHY `mcpServer.server.setRequestHandler` AND NOT `registerTool`. The
 * high-level `registerTool` wants a Zod schema per tool, declared locally. That
 * is a restatement of a schema the server already publishes — a second copy
 * that would have to be edited every time a parameter changed, and would be
 * wrong in between. Forwarding the raw `tools/list` and `tools/call` requests
 * is the SDK's own documented path for this ("for advanced usage like setting
 * custom request handlers, use the underlying Server instance available via
 * the `server` property"), and it means a new tool on makerportal.ai appears
 * here with no release of this package at all.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  RemoteRpcError,
  buildHeaders,
  jsonRpcRequest,
  postRpc,
  resolveEndpoint,
} from './protocol.mjs';

const PACKAGE_NAME = '@makerportal/mcp';

/**
 * One JSON-RPC round trip to the remote.
 *
 * Ids are local and monotonic. The server is stateless, so they correlate
 * nothing beyond the single request they travel with — which is exactly why
 * this bridge can be this small.
 */
function makeCaller({ endpoint, env, fetchImpl }) {
  let nextId = 1;
  let negotiatedVersion = null;

  return {
    setNegotiatedVersion(version) {
      negotiatedVersion = version;
    },
    async call(method, params) {
      const outcome = await postRpc({
        endpoint,
        headers: buildHeaders(env, negotiatedVersion),
        message: jsonRpcRequest(nextId++, method, params),
        fetchImpl,
      });
      if (outcome.kind !== 'result') {
        throw new Error(`${method} was acknowledged with no result — the endpoint treated a request as a notification.`);
      }
      return outcome.result;
    },
  };
}

/**
 * Re-raise a remote failure with the code the server chose.
 *
 * The server answers an invalid tool argument with `-32602` and a `data.valid`
 * list of every accepted value. Flattening that into a generic error would
 * throw away the one thing that lets an agent correct itself on the next call.
 *
 * NOT an `McpError`, deliberately, and this was measured rather than reasoned:
 * `McpError`'s constructor rewrites the message to `MCP error <code>: <text>`,
 * and the SDK then serialises `error.message` verbatim into the JSON-RPC error
 * it sends back — so the client, which builds its own `McpError` from that,
 * ends up reporting `MCP error -32602: MCP error -32602: Unknown filter type…`.
 * The end-to-end run printed exactly that before this was changed. A plain
 * `Error` carrying `code` and `data` hits the same serialiser path
 * (`Number.isSafeInteger(error.code) ? error.code : InternalError`, plus `data`
 * when present) and arrives clean.
 */
function rethrow(error) {
  if (error instanceof RemoteRpcError) {
    const forwarded = new Error(error.message);
    forwarded.code = error.code;
    if (error.data !== undefined) forwarded.data = error.data;
    throw forwarded;
  }
  throw error;
}

/**
 * Build the bridge.
 *
 * Exported separately from `start()` so a test can construct it against a stub
 * `fetch` and drive the real handlers.
 */
export async function createBridge({ env = process.env, fetchImpl = globalThis.fetch, version = '0.0.0' } = {}) {
  const endpoint = resolveEndpoint(env);
  const caller = makeCaller({ endpoint, env, fetchImpl });

  // The one startup round trip. If it fails, this process exits rather than
  // serving an empty tool list that looks like the site has nothing to offer.
  const remote = await caller.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: PACKAGE_NAME, version },
  });
  if (typeof remote?.protocolVersion === 'string') caller.setNegotiatedVersion(remote.protocolVersion);

  const mcpServer = new McpServer(
    {
      name: remote?.serverInfo?.name ?? PACKAGE_NAME,
      version: remote?.serverInfo?.version ?? version,
    },
    {
      capabilities: { tools: {} },
      instructions: remote?.instructions,
    },
  );

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await caller.call('tools/list', {});
    } catch (error) {
      return rethrow(error);
    }
  });

  mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await caller.call('tools/call', request.params);
    } catch (error) {
      return rethrow(error);
    }
  });

  return { server: mcpServer, endpoint, remote };
}

export async function start({ env = process.env, version = '0.0.0' } = {}) {
  const { server, endpoint } = await createBridge({ env, version });
  // stderr, never stdout: stdout is the JSON-RPC channel and one stray line on
  // it corrupts the stream for the whole session.
  process.stderr.write(`${PACKAGE_NAME} → ${endpoint}\n`);
  await server.connect(new StdioServerTransport());
}
