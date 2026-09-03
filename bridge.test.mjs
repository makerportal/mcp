/**
 * The thin client's tests.
 *
 * Two halves, deliberately:
 *
 *  - `protocol.mjs` has **no dependencies**, so its tests run from a bare
 *    checkout with nothing installed. That is where the load-bearing decisions
 *    live: which URL, which headers, and what each HTTP status means.
 *  - `bridge.mjs` needs `@modelcontextprotocol/sdk`, which is a dependency of
 *    THIS package and not of the repo root. Those tests run a real SDK `Client`
 *    against the real SDK `Server` over an in-memory transport pair — no
 *    hand-rolled framing — and they SKIP LOUDLY, naming the install command,
 *    when the SDK is not present. A skip is visible in the runner output; a
 *    silently-passing suite would not be.
 *
 * Nothing here reaches the network. `fetchImpl` is injected everywhere.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CLIENT_PROTOCOL_VERSION,
  DEFAULT_ENDPOINT,
  MAX_RESPONSE_BYTES,
  RemoteRpcError,
  TransportError,
  buildHeaders,
  interpretResponse,
  jsonRpcRequest,
  postRpc,
  readBodyCapped,
  redactHeaders,
  resolveEndpoint,
} from './src/protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'mp_live_planted_key_that_must_never_be_printed';

function interpret(overrides) {
  return interpretResponse({
    status: 200,
    contentType: 'application/json',
    text: '{}',
    endpoint: DEFAULT_ENDPOINT,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Endpoint resolution
// ---------------------------------------------------------------------------

describe('endpoint', () => {
  test('the default is the apex production endpoint', () => {
    assert.equal(resolveEndpoint({}), 'https://makerportal.ai/api/mcp');
    assert.equal(DEFAULT_ENDPOINT.includes('www.'), false, 'the default endpoint is on the www host, which 308s');
  });

  test('MAKERPORTAL_API_URL overrides it, whitespace and all', () => {
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: '  http://localhost:4477/api/mcp  ' }), 'http://localhost:4477/api/mcp');
  });

  test('an empty override falls back to production rather than to an empty URL', () => {
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: '   ' }), DEFAULT_ENDPOINT);
  });

  test('an https override is used verbatim', () => {
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: 'https://example.com/api/mcp' }), 'https://example.com/api/mcp');
  });

  test('plain http is accepted only for loopback hosts — the dev-server case', () => {
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: 'http://localhost:4477/api/mcp' }), 'http://localhost:4477/api/mcp');
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: 'http://127.0.0.1:4477/api/mcp' }), 'http://127.0.0.1:4477/api/mcp');
    assert.equal(resolveEndpoint({ MAKERPORTAL_API_URL: 'http://[::1]:4477/api/mcp' }), 'http://[::1]:4477/api/mcp');
    assert.throws(
      () => resolveEndpoint({ MAKERPORTAL_API_URL: 'http://api.example.com/api/mcp' }),
      (error) => error.message.includes('https://'),
    );
  });

  test('an override carrying user:pass@ credentials is refused — the endpoint is echoed in diagnostics', () => {
    assert.throws(
      () => resolveEndpoint({ MAKERPORTAL_API_URL: 'https://user:pass@example.com/api/mcp' }),
      (error) => error.message.includes('credentials') && error.message.includes('MAKERPORTAL_API_URL'),
    );
  });

  test('a non-URL override is refused, naming the variable to fix', () => {
    assert.throws(
      () => resolveEndpoint({ MAKERPORTAL_API_URL: 'not a url' }),
      (error) => error.message.includes('MAKERPORTAL_API_URL'),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Headers — including the one that must never be printed
// ---------------------------------------------------------------------------

describe('headers', () => {
  test('keyless is the zero-config default: no Authorization at all', () => {
    const headers = buildHeaders({});
    assert.equal('Authorization' in headers, false);
    assert.equal(headers['Content-Type'], 'application/json');
  });

  /**
   * Astro's `checkOrigin` (on by default) rejects a non-GET on-demand request
   * that carries NO Content-Type and no same-origin Origin header — a 403
   * raised before the endpoint's handler runs. Sending
   * `Content-Type: application/json` is what exempts this client from that, so
   * the header is a functional requirement here, not a formality.
   */
  test('Content-Type is always application/json — Astro 403s a POST without one', () => {
    assert.equal(buildHeaders({})['Content-Type'], 'application/json');
    assert.equal(buildHeaders({ MAKERPORTAL_LICENSE_KEY: SECRET })['Content-Type'], 'application/json');
  });

  test('Accept names both media types the streamable-HTTP spec requires', () => {
    const accept = buildHeaders({}).Accept;
    assert.ok(accept.includes('application/json'));
    assert.ok(accept.includes('text/event-stream'));
  });

  test('a license key becomes a Bearer token', () => {
    assert.equal(buildHeaders({ MAKERPORTAL_LICENSE_KEY: SECRET }).Authorization, `Bearer ${SECRET}`);
    assert.equal('Authorization' in buildHeaders({ MAKERPORTAL_LICENSE_KEY: '   ' }), false);
  });

  test('the protocol version header is sent only once one is negotiated', () => {
    assert.equal('MCP-Protocol-Version' in buildHeaders({}), false);
    assert.equal(buildHeaders({}, '2025-06-18')['MCP-Protocol-Version'], '2025-06-18');
    assert.ok(CLIENT_PROTOCOL_VERSION.startsWith('202'));
  });

  test('redactHeaders removes the credential and nothing else', () => {
    const redacted = redactHeaders(buildHeaders({ MAKERPORTAL_LICENSE_KEY: SECRET }));
    assert.equal(JSON.stringify(redacted).includes(SECRET), false);
    assert.equal(redacted['Content-Type'], 'application/json');
  });
});

// ---------------------------------------------------------------------------
// 3. What each answer means
// ---------------------------------------------------------------------------

describe('interpretResponse', () => {
  test('202 is a notification acknowledged, with no result', () => {
    assert.deepEqual(interpret({ status: 202, text: '' }), { kind: 'accepted' });
  });

  test('a JSON-RPC result comes back unwrapped', () => {
    const outcome = interpret({ text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) });
    assert.deepEqual(outcome, { kind: 'result', result: { tools: [] } });
  });

  /**
   * `data.valid` is the list of every accepted value for an enumerated
   * parameter. It is the difference between an agent that fixes its next call
   * and an agent that gives up, so it must survive being re-raised.
   */
  test('a JSON-RPC error keeps its code AND its valid-values list', () => {
    assert.throws(
      () =>
        interpret({
          text: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32602, message: 'Unknown filter type "bogus".', data: { parameter: 'type', valid: ['lowpass', 'notch'] } },
          }),
        }),
      (error) => {
        assert.ok(error instanceof RemoteRpcError);
        assert.equal(error.code, -32602);
        assert.deepEqual(error.data.valid, ['lowpass', 'notch']);
        return true;
      },
    );
  });

  test('an error body wins over the HTTP status', () => {
    // A 401 from the licensing branch carries a JSON-RPC error; reporting
    // "HTTP 401" instead of the server's sentence would lose the reason.
    assert.throws(
      () => interpret({ status: 401, text: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'key not accepted' } }) }),
      (error) => error instanceof RemoteRpcError && error.message === 'key not accepted',
    );
  });

  test('405 says the URL is not an MCP endpoint', () => {
    assert.throws(() => interpret({ status: 405, text: '' }), (error) => {
      assert.ok(error instanceof TransportError);
      assert.ok(error.message.includes('/api/mcp'));
      return true;
    });
  });

  test('404 names the two causes a user can actually check', () => {
    assert.throws(() => interpret({ status: 404, text: '' }), (error) => {
      assert.ok(error.message.includes('MAKERPORTAL_API_URL'));
      assert.ok(error.message.includes('dev server'));
      return true;
    });
  });

  test('an SSE answer is refused rather than half-read', () => {
    assert.throws(
      () => interpret({ contentType: 'text/event-stream', text: 'event: message\n' }),
      (error) => error instanceof TransportError && error.message.includes('SSE'),
    );
  });

  test('an HTML error page is a transport error, not a parse crash', () => {
    assert.throws(
      () => interpret({ status: 500, contentType: 'text/html', text: '<!doctype html><title>500</title>' }),
      (error) => error instanceof TransportError,
    );
  });

  test('a message with neither result nor error is refused', () => {
    assert.throws(
      () => interpret({ text: JSON.stringify({ jsonrpc: '2.0', id: 1 }) }),
      (error) => error instanceof TransportError,
    );
  });

  test('a batch answer to a single request is refused', () => {
    assert.throws(() => interpret({ text: '[]' }), (error) => error instanceof TransportError);
  });
});

// ---------------------------------------------------------------------------
// 4. postRpc against a stub fetch
// ---------------------------------------------------------------------------

describe('postRpc', () => {
  test('it POSTs the message with the headers it was given', async () => {
    let seen = null;
    const outcome = await postRpc({
      endpoint: 'http://localhost:1/api/mcp',
      headers: buildHeaders({ MAKERPORTAL_LICENSE_KEY: SECRET }),
      message: jsonRpcRequest(1, 'tools/list', {}),
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.deepEqual(outcome.result, { tools: [] });
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(seen.init.body), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  });

  test('a network failure is a TransportError naming the endpoint', async () => {
    await assert.rejects(
      postRpc({
        endpoint: 'http://localhost:1/api/mcp',
        headers: buildHeaders({}),
        message: jsonRpcRequest(1, 'ping'),
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      }),
      (error) => error instanceof TransportError && error.message.includes('localhost:1'),
    );
  });

  /**
   * A transport failure is exactly when a user pastes the whole error into a
   * bug report. The key must not be in it.
   */
  test('no failure path prints the license key', async () => {
    const headers = buildHeaders({ MAKERPORTAL_LICENSE_KEY: SECRET });
    for (const stub of [
      async () => {
        throw new Error('boom');
      },
      async () => new Response('<html>nope</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
      async () => new Response('', { status: 404 }),
    ]) {
      const error = await postRpc({ endpoint: 'http://localhost:1/api/mcp', headers, message: jsonRpcRequest(1, 'ping'), fetchImpl: stub }).then(
        () => null,
        (e) => e,
      );
      assert.ok(error, 'expected a rejection');
      assert.equal(`${error.message}${error.stack ?? ''}`.includes(SECRET), false, 'the license key leaked into an error');
    }
  });

  /**
   * `AbortSignal.timeout` bounds time, not bytes. A hostile endpoint can push
   * gigabytes inside the 20 s window; the cap must refuse to buffer them.
   */
  test('a response over the byte cap is refused rather than read into memory', async () => {
    await assert.rejects(
      postRpc({
        endpoint: 'http://localhost:1/api/mcp',
        headers: buildHeaders({}),
        message: jsonRpcRequest(1, 'ping'),
        fetchImpl: async () =>
          new Response('x'.repeat(64), { status: 200, headers: { 'content-type': 'application/json' } }),
        maxResponseBytes: 8,
      }),
      (error) => error instanceof TransportError && error.message.includes('8 bytes'),
    );
  });

  test('a response body at or under the cap reads normally', async () => {
    const outcome = await postRpc({
      endpoint: 'http://localhost:1/api/mcp',
      headers: buildHeaders({}),
      message: jsonRpcRequest(1, 'ping'),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      maxResponseBytes: 10_000,
    });
    assert.deepEqual(outcome.result, { ok: true });
  });

  test('the default cap is the exported maximum', async () => {
    let seen = null;
    await postRpc({
      endpoint: 'http://localhost:1/api/mcp',
      headers: buildHeaders({}),
      message: jsonRpcRequest(1, 'ping'),
      fetchImpl: async () => {
        seen = true;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.ok(seen);
    assert.ok(MAX_RESPONSE_BYTES >= 10 * 1024 * 1024);
  });

  test('readBodyCapped refuses a declared content-length over the cap before reading', async () => {
    await assert.rejects(
      readBodyCapped(
        new Response('tiny', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
        1024,
        'http://localhost:1/api/mcp',
      ),
      (error) => error instanceof TransportError && error.message.includes('declared'),
    );
  });

  test('readBodyCapped returns an empty string for a body-less response', async () => {
    const text = await readBodyCapped(new Response('', { status: 202 }), 1024, 'http://localhost:1/api/mcp');
    assert.equal(text, '');
  });
});

// ---------------------------------------------------------------------------
// 5. The product boundary, at source level
// ---------------------------------------------------------------------------

describe('source boundary', () => {
  const SOURCES = ['src/protocol.mjs', 'src/bridge.mjs', 'bin/makerportal-mcp.mjs'];

  /**
   * `packages/mcp-client` must never import the site's source. It is published
   * to npm; `../../src` does not exist in the tarball, so such an import would
   * be a package that installs and then crashes on first use — and if it
   * somehow did resolve, it would ship the solvers to every installer.
   * `boundary.test.mjs` proves the same thing about the packed bytes; this
   * proves it about the files in the repo, which is where it would be written.
   */
  test('no source file imports anything above the package root', () => {
    for (const relative of SOURCES) {
      const source = readFileSync(join(HERE, relative), 'utf8');
      const escapes = [...source.matchAll(/from\s+['"](\.\.\/\.\.[^'"]*)['"]/g)].map((m) => m[1]);
      assert.deepEqual(escapes, [], `${relative} imports out of the package: ${escapes.join(', ')}`);
      assert.equal(source.includes('makerportal-hub/src'), false, `${relative} names the site's source tree`);
    }
  });

  test('the bin is executable and has a node shebang', () => {
    const binPath = join(HERE, 'bin/makerportal-mcp.mjs');
    assert.ok(readFileSync(binPath, 'utf8').startsWith('#!/usr/bin/env node'));
    // npx runs the file directly; without the exec bit it fails with EACCES on
    // a machine whose npm does not rewrite the mode.
    assert.equal((statSync(binPath).mode & 0o111) !== 0, true, 'bin/makerportal-mcp.mjs is not executable');
  });

  test('the manifest declares exactly one dependency', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies), ['@modelcontextprotocol/sdk']);
    assert.equal(manifest.devDependencies, undefined, 'a devDependency here would be installed by every consumer of a published tarball');
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.private, undefined, 'private:true would make this unpublishable');
  });
});

// ---------------------------------------------------------------------------
// 6. The bridge itself, through a real SDK client
// ---------------------------------------------------------------------------

/**
 * Canned remote. Every answer is a literal JSON-RPC response body, so this
 * exercises the bridge's forwarding and error mapping without a network and
 * without importing one line of the site's source.
 */
function stubRemote({ onCall = () => {} } = {}) {
  return async (_url, init) => {
    const message = JSON.parse(init.body);
    onCall(message, init);
    const reply = (result) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (message.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'makerportal', version: '1.0.0' },
        instructions: 'cite provenance.canonicalUrl',
      });
    }
    if (message.method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'roomModes',
            description: 'Solve the eigenmodes of a rectangular room.',
            inputSchema: { type: 'object', properties: { width: { type: 'number' } }, required: ['width'] },
          },
        ],
      });
    }
    if (message.method === 'tools/call') {
      if (message.params.name !== 'roomModes') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'Unknown tool.', data: { parameter: 'name', valid: ['roomModes'] } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const envelope = {
        inputs: { widthFt: 12 },
        result: { volumeM3: 43.49 },
        provenance: { method: 'eigenmodes', canonicalUrl: 'https://makerportal.ai/lab/room-modes/12x16x8' },
        license: 'free-with-attribution',
      };
      return reply({ content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

let sdk = null;
let sdkError = null;
try {
  const [bridge, clientModule, transportModule, types] = await Promise.all([
    import('./src/bridge.mjs'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  sdk = { createBridge: bridge.createBridge, Client: clientModule.Client, InMemoryTransport: transportModule.InMemoryTransport, types };
} catch (error) {
  sdkError = error instanceof Error ? error.message : String(error);
}

async function connected(fetchImpl, env = {}) {
  const { server } = await sdk.createBridge({ env, fetchImpl, version: '0.1.0' });
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair();
  const client = new sdk.Client({ name: 'test-harness', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('bridge (needs @modelcontextprotocol/sdk)', { skip: sdk === null ? `SDK not installed: ${sdkError}. Run: npm install --prefix packages/mcp-client` : false }, () => {
  test('tools/list is forwarded verbatim — the bridge invents no tool and edits no schema', async () => {
    const { client } = await connected(stubRemote());
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].name, 'roomModes');
    assert.deepEqual(listed.tools[0].inputSchema.required, ['width']);
  });

  test('a tool result arrives with its provenance intact', async () => {
    const { client } = await connected(stubRemote());
    const result = await client.callTool({ name: 'roomModes', arguments: { width: 12 } });
    assert.equal(result.structuredContent.provenance.canonicalUrl, 'https://makerportal.ai/lab/room-modes/12x16x8');
    assert.equal(result.structuredContent.license, 'free-with-attribution');
  });

  /**
   * The message must arrive ONCE, not wrapped twice. Re-raising as the SDK's
   * `McpError` prefixes the message with `MCP error <code>: `, the SDK
   * serialises that prefixed string, and the client prefixes it again — the
   * end-to-end run printed `MCP error -32602: MCP error -32602: Unknown filter
   * type "bogus"`. This asserts the doubling is gone AND that `data.valid`
   * still survives the trip.
   */
  test('a remote -32602 reaches the caller as -32602, valid list and all, prefixed once', async () => {
    const { client } = await connected(stubRemote());
    await assert.rejects(
      client.callTool({ name: 'bogus', arguments: {} }),
      (error) => {
        assert.equal(error.code, -32602);
        assert.ok(String(error.message).includes('Unknown tool'));
        assert.equal(String(error.message).match(/MCP error/g)?.length ?? 0, 1, `message is double-wrapped: ${error.message}`);
        assert.deepEqual(error.data?.valid, ['roomModes'], 'the valid-values list did not survive the bridge');
        return true;
      },
    );
  });

  test('the negotiated protocol version is sent on every request after initialize', async () => {
    const seen = [];
    const { client } = await connected(stubRemote({ onCall: (message, init) => seen.push({ method: message.method, headers: init.headers }) }));
    await client.listTools();
    const initialize = seen.find((s) => s.method === 'initialize');
    const list = seen.find((s) => s.method === 'tools/list');
    assert.equal('MCP-Protocol-Version' in initialize.headers, false, 'a version header was sent before one was negotiated');
    assert.equal(list.headers['MCP-Protocol-Version'], '2025-06-18');
  });

  test('the license key travels on every request and appears nowhere else', async () => {
    const seen = [];
    const { client } = await connected(stubRemote({ onCall: (_m, init) => seen.push(init.headers) }), { MAKERPORTAL_LICENSE_KEY: SECRET });
    const listed = await client.listTools();
    assert.ok(seen.length >= 2);
    for (const headers of seen) assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
  });

  test('the server reports the REMOTE’s identity, not a locally invented one', async () => {
    const { server } = await sdk.createBridge({ env: {}, fetchImpl: stubRemote(), version: '0.1.0' });
    assert.ok(server, 'no server was built');
    const { remote } = await sdk.createBridge({ env: {}, fetchImpl: stubRemote(), version: '0.1.0' });
    assert.equal(remote.serverInfo.name, 'makerportal');
    assert.equal(remote.instructions, 'cite provenance.canonicalUrl');
  });

  test('an unreachable endpoint fails at startup rather than serving an empty tool list', async () => {
    await assert.rejects(
      sdk.createBridge({
        env: {},
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      }),
      (error) => error instanceof TransportError,
    );
  });
});
