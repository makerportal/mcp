#!/usr/bin/env node
/**
 * `npx @makerportal/mcp` — the stdio entry point.
 *
 * Zero configuration is the intended path: with no environment set at all this
 * connects to https://makerportal.ai/api/mcp and serves the free tier.
 *
 *   MAKERPORTAL_API_URL      point somewhere else (a local `astro dev` server);
 *                            must be https://, or http:// on localhost only
 *   MAKERPORTAL_LICENSE_KEY  sent as `Authorization: Bearer …`, never logged
 *
 * A startup failure exits non-zero with a message on stderr. It does NOT fall
 * back to an empty tool list: a client that starts successfully and offers no
 * tools looks like a site with nothing on it, and the real cause (a typo in
 * MAKERPORTAL_API_URL, a dev server that is not running) never reaches anyone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { start } from '../src/bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The published version, read from the manifest rather than restated here. */
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

try {
  await start({ version: packageVersion() });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`@makerportal/mcp failed to start: ${message}\n`);
  process.exit(1);
}
