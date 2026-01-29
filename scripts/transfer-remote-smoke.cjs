const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const s = getStructured(res);
  if (!s) throw new Error(`No structuredContent for ${name}`);
  return s;
}

async function pollTransfer(client, session_id) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const res = await call(client, 'get-result', { session_id, lines: 50 });
    if (res.data?.status && res.data.status !== 'running') return res;
  }
  throw new Error(`transfer did not finish: ${session_id}`);
}

async function main() {
  const machine = process.env.OCTSSH_SMOKE_MACHINE || 'nat';
  const runId = crypto.randomUUID().slice(0, 8);
  const remoteBase = `~/devTest/octssh-xfer-${runId}`;
  const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), `octssh-xfer-${runId}-`));

  const transport = new StdioClientTransport({
    command: 'octssh',
    args: [],
    cwd: process.cwd(),
    stderr: 'inherit'
  });
  const client = new Client({ name: 'octssh-transfer-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    // Ensure remote test dir exists.
    await call(client, 'exec', {
      machine,
      command: `mkdir -p ${remoteBase} && echo OK`
    });

    const localFile = path.join(localTmp, 'hello.txt');
    fs.writeFileSync(localFile, 'v1\n', 'utf8');

    // Upload v1.
    const up1 = await call(client, 'upload', { machine, localPath: localFile, remotePath: `${remoteBase}/hello.txt` });
    assert.equal(up1.ok, true);

    const cat1 = await call(client, 'exec', { machine, command: `cat ${remoteBase}/hello.txt` });
    assert.equal(cat1.ok, true);
    assert.ok(String(cat1.data.stdout).includes('v1'));

    // Upload again should conflict.
    const up2 = await call(client, 'upload', { machine, localPath: localFile, remotePath: `${remoteBase}/hello.txt` });
    assert.equal(up2.ok, false);
    assert.ok(up2.data?.confirm_code);
    assert.ok(Array.isArray(up2.data.conflicts));

    // Overwrite with confirm.
    fs.writeFileSync(localFile, 'v2\n', 'utf8');
    const up3 = await call(client, 'upload', {
      machine,
      localPath: localFile,
      remotePath: `${remoteBase}/hello.txt`,
      confirm_code: up2.data.confirm_code
    });
    assert.equal(up3.ok, true);

    const cat2 = await call(client, 'exec', { machine, command: `cat ${remoteBase}/hello.txt` });
    assert.equal(cat2.ok, true);
    assert.ok(String(cat2.data.stdout).includes('v2'));

    // Download to a fresh local directory.
    const dlDir = path.join(localTmp, 'downloaded');
    fs.mkdirSync(dlDir);
    const dl1 = await call(client, 'download', { machine, remotePath: `${remoteBase}/hello.txt`, localPath: dlDir });
    assert.equal(dl1.ok, true);

    const dlFile = path.join(dlDir, 'hello.txt');
    assert.equal(fs.readFileSync(dlFile, 'utf8').trim(), 'v2');

    // Download again must refuse overwrite.
    const dl2 = await call(client, 'download', { machine, remotePath: `${remoteBase}/hello.txt`, localPath: dlDir });
    assert.equal(dl2.ok, false);
    assert.ok(dl2.data?.totalConflicts >= 1);

    // Security: exec must refuse sudo.
    const s1 = await call(client, 'exec', { machine, command: 'sudo echo hi' });
    assert.equal(s1.ok, false);

    // Security: sudo-exec must refuse high-risk patterns.
    const s2 = await call(client, 'sudo-exec', { machine, command: 'ufw disable' });
    assert.equal(s2.ok, false);

    // Security: destructive rm requires virtual confirm.
    await call(client, 'exec', { machine, command: `mkdir -p ${remoteBase}/rmtest && touch ${remoteBase}/rmtest/a` });
    const rm1 = await call(client, 'exec', { machine, command: `rm -rf ${remoteBase}/rmtest` });
    assert.equal(rm1.ok, false);
    assert.ok(rm1.data?.confirm_code);

    const rm2 = await call(client, 'exec', { machine, command: `rm -rf ${remoteBase}/rmtest`, confirm_code: rm1.data.confirm_code });
    assert.equal(rm2.ok, true);

    // Async upload.
    fs.writeFileSync(localFile, 'v3\n', 'utf8');
    const au = await call(client, 'upload-async', { machine, localPath: localFile, remotePath: `${remoteBase}/hello2.txt` });
    assert.equal(au.ok, true);
    const auDone = await pollTransfer(client, au.data.session_id);
    assert.ok(['done', 'failed', 'cancelled'].includes(auDone.data.status));
    assert.equal(auDone.data.status, 'done');

    // Async download.
    const ad = await call(client, 'download-async', { machine, remotePath: `${remoteBase}/hello2.txt`, localPath: path.join(localTmp, 'downloaded2') });
    assert.equal(ad.ok, true);
    const adDone = await pollTransfer(client, ad.data.session_id);
    assert.equal(adDone.data.status, 'done');

    console.log('REMOTE TRANSFER SMOKE: OK', { machine, remoteBase, localTmp });
  } finally {
    await transport.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
