const test = require('node:test');
const assert = require('node:assert/strict');

test('mcp server factory exports', () => {
  // The test suite runs after build, so this should exist.
  // If this fails, the package scaffolding isn't producing a runnable artifact.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../dist/mcp/server.js');
  assert.equal(typeof mod.createOctsshServer, 'function');

  const server = mod.createOctsshServer();
  assert.equal(typeof server.connect, 'function');
});
