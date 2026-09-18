'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createApp, profileFileForRequest, readDataForRequest, writeDataFile
} = require('../server.js');

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

test('按客户端 IP 隔离配置，并为首次访问预加载默认配置', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quickcopy-profile-'));
  try {
    const defaultFile = path.join(dir, 'resume.json');
    await writeDataFile(defaultFile, {
      version: 1, title: '默认简历', updatedAt: '2026-01-01T00:00:00.000Z', sections: []
    }, { backup: false });
    const requestA = { socket: { remoteAddress: '192.168.1.20' } };
    const requestB = { socket: { remoteAddress: '192.168.1.21' } };
    const profileA = profileFileForRequest(defaultFile, requestA, true);
    const profileB = profileFileForRequest(defaultFile, requestB, true);

    assert.notEqual(profileA, profileB);
    assert.match(profileA, /profiles[\\/]([a-f0-9]{24})\.json$/);
    assert.equal(profileFileForRequest(defaultFile, requestA, false), defaultFile);

    const loaded = await readDataForRequest(defaultFile, profileA);
    assert.equal(loaded.data.title, '默认简历');
    await fsp.access(profileA); // 首次访问应创建独立配置文件
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

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

test('PUT /api/data 原子写入并备份旧文件，GET 能原样读回', async () => {
  await withServer(async ({ base, dataFile, dir }) => {
    await fetch(`${base}/api/data`); // 先让模板文件生成

    const next = {
      title: '测试简历',
      sections: [
        { id: 'basic', title: '基本信息', children: [{ id: 'name', title: '姓名', value: '张三' }] }
      ]
    };
    const put = await fetch(`${base}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.data.title, '测试简历');
    assert.ok(saved.data.updatedAt, '写入时应刷新 updatedAt');
    assert.ok(saved.mtime > 0);

    const read = await (await fetch(`${base}/api/data`)).json();
    assert.deepEqual(read.data.sections, saved.data.sections);

    const onDisk = JSON.parse(await fsp.readFile(dataFile, 'utf8'));
    assert.equal(onDisk.sections[0].children[0].value, '张三');

    const backups = await fsp.readdir(path.join(dir, 'backups'));
    assert.equal(backups.length, 1, '覆盖前应留一份备份');
  });
});

test('PUT /api/data 拒绝非法 JSON，且不破坏磁盘上的原文件', async () => {
  await withServer(async ({ base, dataFile }) => {
    await fetch(`${base}/api/data`);
    const before = await fsp.readFile(dataFile, 'utf8');

    const res = await fetch(`${base}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 这不是 JSON'
    });
    assert.equal(res.status, 400);
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
