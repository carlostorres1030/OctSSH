const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const machine = process.env.OCTSSH_SMOKE_MACHINE || 'nat';

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: process.cwd(),
    env: {
      // Inherit ssh config settings if caller wants to override.
      ...(process.env.OCTSSH_SSH_CONFIG ? { OCTSSH_SSH_CONFIG: process.env.OCTSSH_SSH_CONFIG } : {}),
      ...(process.env.OCTSSH_HOME ? { OCTSSH_HOME: process.env.OCTSSH_HOME } : {})
    },
    stderr: 'inherit'
  });

  const client = new Client({ name: 'octssh-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const list = await client.callTool({ name: 'list', arguments: {} });
  console.log('list:', list.structuredContent ?? list.content?.[0]?.text);

  const exec = await client.callTool({ name: 'exec', arguments: { machine, command: 'echo OK && date' } });
  console.log('exec:', exec.structuredContent ?? exec.content?.[0]?.text);

  const asyncRes = await client.callTool({
    name: 'exec-async',
    arguments: { machine, command: 'echo start; sleep 2; echo done; date' }
  });
  const started = asyncRes.structuredContent;
  console.log('exec-async:', started ?? asyncRes.content?.[0]?.text);

  if (!started?.data?.session_id) {
    throw new Error('exec-async did not return session_id');
  }
  const session_id = started.data.session_id;

  // Poll result.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await client.callTool({ name: 'get-result', arguments: { session_id, lines: 200 } });
    const data = res.structuredContent?.data;
    console.log('get-result:', data ?? res.content?.[0]?.text);
    if (data && data.status !== 'running') {
      await transport.close();
      return;
    }
  }

  // If it's still running, dump remote diagnostics.
  const diag = await client.callTool({
    name: 'exec',
    arguments: {
      machine,
      command: [
        `echo '---run-dir---'`,
        `ls -la "$HOME/.octssh/runs/${session_id}" || true`,
        `echo '---meta---'`,
        `cat "$HOME/.octssh/runs/${session_id}/meta.json" 2>/dev/null || true`,
        `echo '---stdout---'`,
        `cat "$HOME/.octssh/runs/${session_id}/stdout.log" 2>/dev/null || true`,
        `echo '---stderr---'`,
        `cat "$HOME/.octssh/runs/${session_id}/stderr.log" 2>/dev/null || true`,
        `echo '---screen-ls---'`,
        `screen -ls | head -n 50 || true`,
      ].join('; ')
    }
  });
  console.log('diagnostics:', diag.structuredContent ?? diag.content?.[0]?.text);

  await transport.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
