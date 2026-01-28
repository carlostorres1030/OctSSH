const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function getStructured(toolResult) {
  if (toolResult && typeof toolResult === 'object') {
    if (toolResult.structuredContent && typeof toolResult.structuredContent === 'object') {
      return toolResult.structuredContent;
    }
    if (Array.isArray(toolResult.content) && toolResult.content[0]?.type === 'text') {
      try {
        return JSON.parse(toolResult.content[0].text);
      } catch {
        return null;
      }
    }
  }
  return null;
}

test('MCP client can spawn OctSSH server and call list/sleep', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-mcp-client-'));
  const cfgPath = path.join(tmp, 'ssh_config');
  const octsshHome = path.join(tmp, 'octssh_home');

  // Deterministic host list for tests.
  fs.writeFileSync(
    cfgPath,
    ['Host nat', '  HostName example.invalid', '  User root', ''].join('\n'),
    'utf8'
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: path.join(__dirname, '..'),
    env: {
      OCTSSH_SSH_CONFIG: cfgPath,
      OCTSSH_HOME: octsshHome
    },
    stderr: 'pipe'
  });

  const client = new Client(
    { name: 'octssh-test-client', version: '0.0.0' },
    { capabilities: {} }
  );

  // Capture stderr for debugging if the server fails early.
  const stderr = [];
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  }

  try {
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('sleep'));

    const listRes = await client.callTool({ name: 'list', arguments: {} });
    const list = getStructured(listRes);
    assert.ok(list, `Expected structured content; stderr: ${stderr.join('')}`);
    assert.equal(list.ok, true);
    assert.deepEqual(list.data.hosts, ['nat']);

    const sleepRes = await client.callTool({ name: 'sleep', arguments: { time: 1 } });
    const sleep = getStructured(sleepRes);
    assert.ok(sleep);
    assert.equal(sleep.ok, true);
    assert.equal(sleep.tool, 'sleep');
  } finally {
    await transport.close();
  }
});
