import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Proxy } from '../src/proxy.mjs';
import { classifyToolCall, shouldBlock } from '../src/proxy-classify.mjs';

test('receipt access cannot read a JSON file outside the receipt directory', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-audit-receipt-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'private-fixture.json'), JSON.stringify({ sentinel: 'SYNTHETIC_PRIVATE_DATA' }));
  const proxy = new Proxy({ workspace });
  const result = await proxy.callBuiltin('get_receipt', { receipt_id: '../private-fixture' });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_DATA/);
});

test('read and draft words cannot suppress an outbound send classification', () => {
  for (const toolName of ['read_send_email', 'draft_send_email', 'get_slack_post', 'list_calendar_create']) {
    assert.equal(shouldBlock(classifyToolCall({ toolName, args: {} })), true, toolName);
  }
});

test('receipt access rejects a symbolic link outside the receipt directory', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-audit-symlink-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'receipts'));
  fs.writeFileSync(path.join(workspace, 'private-fixture.json'), JSON.stringify({ sentinel: 'SYNTHETIC_PRIVATE_DATA' }));
  fs.symlinkSync('../private-fixture.json', path.join(workspace, 'receipts', 'linked.json'));
  const result = await new Proxy({ workspace }).callBuiltin('get_receipt', { receipt_id: 'linked' });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_DATA/);
});
