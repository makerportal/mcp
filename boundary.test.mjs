/**
 * The product boundary, enforced on the bytes that would actually be published.
 *
 * WHY THIS IS NOT A CODE REVIEW RULE. `packages/mcp-client` is a transport
 * shim; the solvers live on makerportal.ai and are the same functions that
 * render the published pages. The failure mode this guards against is not
 * malice, it is convenience: "just inline the coefficient maths so it works
 * offline" is a one-line change that looks like an improvement and quietly
 * creates a second implementation of a measurement — the exact drift mode D-143
 * records, where a hand-derived DC gain printed "+Infinity dB" on 29 live pages
 * while every unit test stayed green.
 *
 * WHY IT PACKS RATHER THAN GREPS THE DIRECTORY. `files` in `package.json` is a
 * whitelist, and a grep over the source tree would keep passing if someone
 * added a solver file that `files` happened to include, or if `files` were
 * widened to `["."]`. `npm pack --dry-run --json` reports the exact list npm
 * would ship; this test asserts that list, then reads every named file and
 * greps its CONTENT. Both halves matter: the list catches "a new file got
 * shipped", the content catches "an existing file grew a solver".
 *
 * Needs npm on PATH and nothing else — no network, no SDK, no build.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Exactly what a publish should contain.
 *
 * `package.json` is always included by npm and is not in the `files` list.
 * Anything else appearing here is a change someone must justify — which is the
 * point of asserting the whole set rather than a count.
 */
const EXPECTED_FILES = [
  'LICENSE',
  'README.md',
  'bin/makerportal-mcp.mjs',
  'package.json',
  'server.json',
  'src/bridge.mjs',
  'src/protocol.mjs',
].sort();

/**
 * Symbols that exist only in the site's solver source.
 *
 * `analyzeBiquadPage`, `rbjCoeffs` and `fitReport` are the three named in the
 * work package. The rest are the other entry points and the internals a
 * copy-paste would most likely drag along.
 */
const SOLVER_SYMBOLS = [
  'analyzeBiquadPage',
  'rbjCoeffs',
  'fitReport',
  'analyzeRoom',
  'wordFormsFor',
  'allBiquadPages',
  'allPairs',
  'solver-registry',
];

let packed = null;

before(() => {
  // `--json` puts the manifest on stdout; npm's progress chatter goes to
  // stderr and is discarded.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: HERE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  packed = JSON.parse(raw)[0];
});

describe('published tarball', () => {
  test('it ships exactly the expected files, and no others', () => {
    const paths = packed.files.map((f) => f.path).sort();
    assert.deepEqual(paths, EXPECTED_FILES);
  });

  test('no packed path escapes the package directory', () => {
    for (const { path } of packed.files) {
      assert.equal(isAbsolute(path), false, `${path} is an absolute path`);
      assert.equal(normalize(path).startsWith('..'), false, `${path} reaches outside the package`);
      assert.equal(path.includes('node_modules'), false, `${path} is a vendored dependency`);
    }
  });

  test('the tarball is small enough that a solver could not be hiding in it', () => {
    // A transport shim. If this ever crosses 100 kB unpacked, something large
    // arrived that nobody meant to ship.
    assert.ok(packed.unpackedSize < 100_000, `unpacked size is ${packed.unpackedSize} bytes`);
  });

  /**
   * THE GATE. Every packed byte, read from disk and searched for solver
   * symbols. Watched failing on a planted `analyzeBiquadPage` reference before
   * this was committed.
   */
  test('no packed file contains any solver symbol', () => {
    const offences = [];
    for (const { path } of packed.files) {
      const content = readFileSync(join(HERE, path), 'utf8');
      for (const symbol of SOLVER_SYMBOLS) {
        if (content.includes(symbol)) offences.push(`${path} contains "${symbol}"`);
      }
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });

  test('no packed file imports out of the package', () => {
    const offences = [];
    for (const { path } of packed.files) {
      const content = readFileSync(join(HERE, path), 'utf8');
      for (const match of content.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.\.\/\.\.[^'"]*)['"]/g)) {
        offences.push(`${path} imports ${match[1]}`);
      }
    }
    assert.deepEqual(offences, []);
  });

  test('no packed file carries a credential-looking literal', () => {
    // The repo-wide secret scan skips node_modules but not this directory; this
    // is the narrower, package-specific version of the same rule.
    for (const { path } of packed.files) {
      const content = readFileSync(join(HERE, path), 'utf8');
      assert.equal(/\bsk-[A-Za-z0-9]{16,}\b/.test(content), false, `${path} looks like it carries a key`);
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content), false, `${path} carries a private key`);
    }
  });
});

describe('the registry manifest and the npm manifest agree', () => {
  test('server.json validates against the fields the official registry requires', () => {
    const server = JSON.parse(readFileSync(join(HERE, 'server.json'), 'utf8'));
    for (const field of ['name', 'description', 'version']) {
      assert.ok(server[field], `server.json is missing the required field ${field}`);
    }
    // Reverse-DNS with exactly one slash — the registry rejects anything else.
    assert.match(server.name, /^[a-z0-9.-]+\/[a-z0-9-]+$/);
    assert.equal(server.name.split('/').length, 2);
    // maxLength 100 in the published schema. A description that fails
    // validation is a submission that bounces, discovered by the owner rather
    // than here, which is the wrong place to find it.
    assert.ok(server.description.length <= 100, `description is ${server.description.length} characters`);
  });

  /**
   * The official registry proves npm ownership by matching `mcpName` in
   * `package.json` against `name` in `server.json`. They are two files, so
   * they drift; this is the check that says so before a submission bounces.
   */
  test('package.json mcpName equals server.json name', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
    const server = JSON.parse(readFileSync(join(HERE, 'server.json'), 'utf8'));
    assert.equal(manifest.mcpName, server.name);
  });

  test('the npm package identifier and version match on both sides', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
    const server = JSON.parse(readFileSync(join(HERE, 'server.json'), 'utf8'));
    const npmPackage = server.packages.find((p) => p.registryType === 'npm');
    assert.ok(npmPackage, 'server.json declares no npm package');
    assert.equal(npmPackage.identifier, manifest.name);
    assert.equal(npmPackage.version, manifest.version);
    assert.equal(server.version, manifest.version);
    // Only registry.npmjs.org is accepted by the official registry.
    assert.equal(npmPackage.registryBaseUrl, 'https://registry.npmjs.org');
  });

  test('the declared remote is the apex endpoint this package defaults to', () => {
    const server = JSON.parse(readFileSync(join(HERE, 'server.json'), 'utf8'));
    const remote = server.remotes.find((r) => r.type === 'streamable-http');
    assert.ok(remote, 'server.json declares no streamable-http remote');
    assert.equal(remote.url, 'https://makerportal.ai/api/mcp');
    assert.equal(remote.url.includes('www.'), false, 'the declared remote is on the www host, which 308s');
    assert.equal(server.remotes.some((r) => r.type === 'sse'), false, 'an SSE remote is declared and this server never streams');
  });

  test('every declared environment variable is one the client actually reads', () => {
    const server = JSON.parse(readFileSync(join(HERE, 'server.json'), 'utf8'));
    const source = readFileSync(join(HERE, 'src/protocol.mjs'), 'utf8');
    for (const variable of server.packages[0].environmentVariables) {
      assert.ok(source.includes(variable.name), `server.json declares ${variable.name}, which no source file reads`);
      assert.equal(variable.isRequired, false, `${variable.name} is declared required — the keyless tier is the default path`);
    }
    const secret = server.packages[0].environmentVariables.find((v) => v.name === 'MAKERPORTAL_LICENSE_KEY');
    assert.equal(secret.isSecret, true, 'the license key is not marked secret');
  });
});
