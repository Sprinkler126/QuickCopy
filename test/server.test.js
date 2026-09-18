'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server.js');

/** 起一个只监听回环、用临时数据文件的服务器，跑完自动清理 */
async function withServer(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quickcopy-test-'));
  const dataFile = path.join(dir, 'resume.json');
  const server = createApp({ host: '127.0.0.1', port: 0, dataFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, dataFile, dir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('数据文件不存在时，GET /api/data 自动创建空模板', async () => {
  await withServer(async ({ base, dataFile }) => {
    const res = await fetch(`${base}/api/data`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.data.sections));
    assert.equal(payload.path, dataFile);
    await fsp.access(dataFile); // 文件已落盘
  });
});

test('PUT /api/data 被拒绝，调用方数据不会写入服务端', async () => {
  await withServer(async ({ base, dataFile }) => {
    const initial = await (await fetch(`${base}/api/data`)).json();
    const next = {
      title: '调用方私有简历',
      sections: [{ id: 'basic', title: '基本信息', children: [{ id: 'name', title: '姓名', value: '张三' }] }]
    };
    const put = await fetch(`${base}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    });
    assert.equal(put.status, 405);
    assert.match((await put.json()).error, /只读/);

    const after = await (await fetch(`${base}/api/data`)).json();
    assert.deepEqual(after.data, initial.data);
    const onDisk = JSON.parse(await fsp.readFile(dataFile, 'utf8'));
    assert.deepEqual(onDisk, initial.data);
  });
});

test('PUT /api/data 对任意请求体均拒绝，且不改写默认配置', async () => {
  await withServer(async ({ base, dataFile }) => {
    await fetch(`${base}/api/data`);
    const before = await fsp.readFile(dataFile, 'utf8');

    const res = await fetch(`${base}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 这不是 JSON'
    });
    assert.equal(res.status, 405);
    assert.equal(await fsp.readFile(dataFile, 'utf8'), before);
  });
});

test('未知接口与方法返回对应错误码', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/data`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${base}/api/meta`, { method: 'POST' })).status, 405);
  });
});

test('静态资源可访问，路径穿越被挡', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /简历速取/);

    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/core.js`)).status, 200);

    const escaped = await fetch(`${base}/..%2fserver.js`);
    assert.ok([403, 404].includes(escaped.status), `期望被挡住，实际 ${escaped.status}`);
  });
});

test('GET /api/meta 返回文件 mtime，未创建文件时为 0', async () => {
  await withServer(async ({ base, dataFile }) => {
    const empty = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(empty.mtime, 0);
    assert.equal(empty.path, dataFile);

    await fetch(`${base}/api/data`);
    const after = await (await fetch(`${base}/api/meta`)).json();
    assert.ok(after.mtime > 0);
  });
});
