#!/usr/bin/env node
'use strict';

/**
 * 简历速取助手 —— 本地服务。
 *
 * 只做两件事：
 *   1. 把 public/ 目录当静态站点托管（浏览器打开 http://127.0.0.1:<port>/）
 *   2. 读写「默认位置」的 JSON 数据文件，供页面自动加载 / 自动保存
 *
 * 零依赖，只用 Node 内置模块。默认只监听 127.0.0.1，不对外网暴露。
 *
 * 用法：
 *   node server.js [--port 5178] [--data <resume.json 路径>] [--no-open]
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { exec } = require('node:child_process');
const crypto = require('node:crypto');

const Core = require('./public/core.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'resume.json');
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB，简历数据远够用
const BACKUP_KEEP = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.QUICKCOPY_PORT) || 5178,
    host: process.env.QUICKCOPY_HOST || '0.0.0.0',
    dataFile: process.env.QUICKCOPY_DATA || DEFAULT_DATA_FILE,
    profileByIp: process.env.QUICKCOPY_PER_IP !== '0',
    open: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = () => (inlineValue !== null ? inlineValue : argv[++i]);
    switch (key) {
      case '--port': case '-p':
        opts.port = Number(takeValue());
        break;
      case '--data': case '-d':
        opts.dataFile = path.resolve(takeValue());
        break;
      case '--host':
        opts.host = takeValue();
        break;
      case '--shared-data':
        opts.profileByIp = false;
        break;
      case '--per-ip':
        opts.profileByIp = true;
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--parent-pid':
        opts.parentPid = Number(takeValue());
        break;
      case '--help': case '-h':
        opts.help = true;
        break;
      default:
        if (key) console.warn(`[warn] 忽略未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    throw new Error(`端口不合法：${opts.port}`);
  }
  return opts;
}

/* -------------------------------------------------------------- 数据文件 */

function emptyTemplate() {
  return {
    version: Core.DATA_VERSION,
    title: '简历速取',
    updatedAt: new Date().toISOString(),
    sections: [
      {
        id: Core.uid('sec'),
        title: '基本信息',
        children: [{ id: Core.uid('n'), title: '示例字段', value: '点击卡片即可复制这段文字' }]
      }
    ]
  };
}

/** 读取数据文件；文件不存在时用空模板落盘。返回 { data, warnings } */
async function readDataFile(file, initialData) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const template = initialData || emptyTemplate();
    await writeDataFile(file, template, { backup: false });
    return {
      data: template,
      warnings: [initialData ? `首次访问，已加载默认配置` : `数据文件不存在，已创建空模板：${file}`]
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // 不覆盖坏文件：原样报错，让用户自己处理
    const e = new Error(`数据文件不是合法 JSON：${err.message}`);
    e.status = 422;
    throw e;
  }
  return Core.normalizeData(raw);
}

/** 原子写入：先写同目录临时文件，再 rename 覆盖，避免半截文件 */
async function writeDataFile(file, data, { backup = true } = {}) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  if (backup) {
    try {
      await fsp.access(file);
      await backupFile(file);
    } catch {
      /* 文件还不存在，无需备份 */
    }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function backupFile(file) {
  const dir = path.join(path.dirname(file), 'backups');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const name = `${path.basename(file, '.json')}-${stamp}.json`;
  await fsp.copyFile(file, path.join(dir, name));
  const entries = (await fsp.readdir(dir))
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) {
    await fsp.rm(path.join(dir, stale), { force: true }).catch(() => {});
  }
}

async function fileMtime(file) {
  try {
    const st = await fsp.stat(file);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/** 仅使用 TCP 连接地址；不信任可伪造的 X-Forwarded-For 请求头。 */
function getClientIp(req) {
  const address = (req.socket && req.socket.remoteAddress) || 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function profileFileForRequest(dataFile, req, profileByIp) {
  if (!profileByIp) return dataFile;
  // 文件名只保存 IP 的不可逆短哈希，避免在磁盘目录中直接暴露设备地址。
  const key = crypto.createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 24);
  return path.join(path.dirname(dataFile), 'profiles', key + '.json');
}

/** 首次访问的设备从默认配置克隆一份，后续读写自己的配置文件。 */
async function readDataForRequest(defaultFile, profileFile) {
  if (defaultFile === profileFile) return readDataFile(defaultFile);
  const base = await readDataFile(defaultFile);
  const profile = await readDataFile(profileFile, base.data);
  return { data: profile.data, warnings: base.warnings.concat(profile.warnings) };
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + rel);
    return;
  }
  if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString()
  });
  fs.createReadStream(target).pipe(res);
}

function createApp(opts) {
  const dataFile = opts.dataFile;
  const profileByIp = Boolean(opts.profileByIp);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || opts.host}`);
    const pathname = url.pathname;
    const requestDataFile = profileFileForRequest(dataFile, req, profileByIp);

    try {
      if (pathname === '/api/meta') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: '方法不允许' });
        return sendJson(res, 200, {
          path: requestDataFile,
          mtime: await fileMtime(requestDataFile)
        });
      }

      if (pathname === '/api/data') {
        if (req.method === 'GET') {
          const { data, warnings } = await readDataForRequest(dataFile, requestDataFile);
          return sendJson(res, 200, {
            data,
            warnings,
            mtime: await fileMtime(requestDataFile),
            path: requestDataFile
          });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          let raw;
          try {
            raw = JSON.parse(body);
          } catch (err) {
            return sendJson(res, 400, { error: `请求体不是合法 JSON：${err.message}` });
          }
          const { data, warnings } = Core.normalizeData(raw);
          Core.touch(data);
          // 首次 PUT 也先生成此设备的默认副本，保证不同 IP 的数据互不覆盖。
          await readDataForRequest(dataFile, requestDataFile);
          await writeDataFile(requestDataFile, data);
          return sendJson(res, 200, {
            data,
            warnings,
            mtime: await fileMtime(requestDataFile),
            path: requestDataFile
          });
        }
        return sendJson(res, 405, { error: '方法不允许' });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: '未知接口：' + pathname });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: '方法不允许' });
      }
      return await serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[error]', err);
      sendJson(res, status, { error: err.message || '服务器内部错误' });
    }
  });
}

/* ------------------------------------------------------------------ 启动 */

function listen(server, opts, attemptsLeft) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        console.warn(`[warn] 端口 ${opts.port} 被占用，尝试 ${opts.port + 1}`);
        opts.port += 1;
        resolve(listen(server, opts, attemptsLeft - 1));
        return;
      }
      reject(err);
    });
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn(`[warn] 自动打开浏览器失败，请手动访问 ${url}`);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      '简历速取助手',
      '',
      '  node server.js [选项]',
      '',
      '  --port <n>    监听端口，默认 5178（被占用时自动 +1）',
      '  --data <file> 数据文件路径，默认 ./data/resume.json（作为默认配置）',
      '  --host <ip>   监听地址，默认 0.0.0.0（局域网可访问）',
      '  --shared-data 关闭按 IP 分配置，所有访问者共用一个数据文件',
      '  --per-ip      开启按 IP 分配置（默认开启）',
      '  --no-open     启动后不自动打开浏览器',
      '  --parent-pid  内部参数：该进程结束后自动退出（托盘启动器用）'
    ].join('\n'));
    return;
  }

  await fsp.mkdir(path.dirname(opts.dataFile), { recursive: true });
  // 启动时先探一次数据文件，坏 JSON 就直接报出来
  const { data, warnings } = await readDataFile(opts.dataFile);
  warnings.forEach((w) => console.warn('[warn] ' + w));

  const server = createApp(opts);
  await listen(server, opts, 10);

  const url = `http://${opts.host}:${opts.port}/`;
  console.log('');
  console.log('  简历速取助手已启动');
  console.log('  ── 页面：    ' + url);
  console.log('  ── 默认配置：' + opts.dataFile);
  console.log('  ── 条目数：  ' + Core.countNodes(data) + '，分类：' + data.sections.length);
  console.log('  ── 访问模式：' + (opts.profileByIp ? '按客户端 IP 分别保存配置' : '所有访问者共用默认配置'));
  console.log('  ── 编辑数据文件后，页面会自动重新加载（Ctrl+C 停止服务）');
  console.log('');
  if (opts.open) openBrowser(url);

  const shutdown = () => {
    console.log('\n服务已停止。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 托盘启动器会传 --parent-pid：托盘一退出，服务也跟着退，不留僵尸 node 进程
  if (Number.isInteger(opts.parentPid) && opts.parentPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(opts.parentPid, 0);
      } catch {
        console.log('[info] 父进程已退出，服务随之停止。');
        clearInterval(timer);
        shutdown();
      }
    }, 3000);
    timer.unref();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}

module.exports = {
  createApp, readDataFile, readDataForRequest, writeDataFile, parseArgs, emptyTemplate,
  getClientIp, profileFileForRequest
};
