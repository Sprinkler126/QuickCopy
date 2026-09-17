'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Core = require('../public/core.js');

const DATA_FILE = path.join(__dirname, '..', 'data', 'resume.example.json');

/* ------------------------------------------------------------ 复制文本 */

test('copyText 按 copy > value > title 取值', () => {
  assert.equal(Core.copyText({ title: 'T', value: 'V', copy: 'C' }), 'C');
  assert.equal(Core.copyText({ title: 'T', value: 'V' }), 'V');
  assert.equal(Core.copyText({ title: 'T' }), 'T');
  assert.equal(Core.copyText(null), '');
});

test('collectCopyText 把整段经历拼成多行', () => {
  const node = {
    id: 'job', title: '某公司 · 后端', children: [
      { id: 'a', title: '时间', value: '2024-01 ~ 2024-06' },
      { id: 'b', title: '内容', value: '做了些事' }
    ]
  };
  assert.equal(Core.collectCopyText(node), '某公司 · 后端\n时间：2024-01 ~ 2024-06\n内容：做了些事');
});

test('collectCopyText 对叶子节点只返回它的值', () => {
  assert.equal(Core.collectCopyText({ id: 'a', title: '电话', value: '123' }), '123');
});

/* -------------------------------------------------------------- 树操作 */

function sample() {
  return Core.normalizeData({
    title: '示例',
    sections: [
      { id: 's1', title: '一', children: [{ id: 'a', title: 'A', value: 'va' }, { id: 'b', title: 'B', value: 'vb' }] },
      { id: 's2', title: '二', children: [{ id: 'c', title: 'C', children: [{ id: 'c1', title: 'C1', value: 'vc1' }] }] }
    ]
  }).data;
}

test('locate 能定位任意深度的节点，并给出所在数组', () => {
  const data = sample();
  const hit = Core.locate(data, 'c1');
  assert.ok(hit);
  assert.equal(hit.node.title, 'C1');
  assert.equal(hit.parent.id, 'c');
  const section = Core.locate(data, 's2');
  assert.equal(section.parent, null);
  assert.equal(section.list, data.sections);
  assert.equal(Core.locate(data, '不存在'), null);
});

test('insertNode 支持插到分类下和顶层', () => {
  const data = sample();
  Core.insertNode(data, 'a-parent-missing', { id: 'x' }); // 找不到父节点应无副作用
  assert.equal(Core.locate(data, 'x'), null);

  Core.insertNode(data, 's1', { id: 'x', title: 'X', value: 'vx' });
  assert.deepEqual(data.sections[0].children.map((n) => n.id), ['a', 'b', 'x']);

  Core.insertNode(data, '__root__', { id: 's0', title: '零', children: [] }, 0);
  assert.deepEqual(data.sections.map((s) => s.id), ['s0', 's1', 's2']);
});

test('removeNode / moveNode 只在同级内生效', () => {
  const data = sample();
  assert.equal(Core.moveNode(data, 'b', -1), true);
  assert.deepEqual(data.sections[0].children.map((n) => n.id), ['b', 'a']);
  assert.equal(Core.moveNode(data, 'b', -1), false, '已在首位不能再上移');
  assert.equal(Core.moveNode(data, 'a', 1), false, '已在末位不能再下移');
  assert.equal(Core.moveNode(data, 'a', -1), true);
  assert.deepEqual(data.sections[0].children.map((n) => n.id), ['a', 'b']);

  Core.removeNode(data, 'c');
  assert.equal(Core.locate(data, 'c'), null);
  assert.equal(Core.locate(data, 'c1'), null, '删除父节点应带走子树');
});

test('reorderNode 可把卡片放到同级目标的前后，拒绝跨层拖放', () => {
  const data = sample();
  assert.equal(Core.reorderNode(data, 'a', 'b', true), true);
  assert.deepEqual(data.sections[0].children.map((n) => n.id), ['b', 'a']);
  assert.equal(Core.reorderNode(data, 'a', 'b', false), true);
  assert.deepEqual(data.sections[0].children.map((n) => n.id), ['a', 'b']);
  assert.equal(Core.reorderNode(data, 'a', 'c1', true), false, '不同父级不能移动');
  assert.equal(Core.reorderNode(data, 'a', 'a', true), false, '不能拖到自身');
});

test('countNodes / walk 覆盖整棵树', () => {
  const data = sample();
  assert.equal(Core.countNodes(data), 6); // s1、a、b、s2、c、c1
  const ids = [];
  Core.walk(data, (node) => { ids.push(node.id); });
  assert.deepEqual(ids, ['s1', 'a', 'b', 's2', 'c', 'c1']);
});

/* ---------------------------------------------------------------- 搜索 */

test('filterTree 保留命中节点及其祖先链', () => {
  const data = sample();
  const hit = Core.filterTree(data, 'vb');
  assert.deepEqual(hit.sections.map((s) => s.id), ['s1']);
  assert.deepEqual(hit.sections[0].children.map((n) => n.id), ['b']);
});

test('filterTree 命中父节点时保留整棵子树', () => {
  const data = sample();
  const hit = Core.filterTree(data, '二');
  assert.deepEqual(hit.sections.map((s) => s.id), ['s2']);
  assert.deepEqual(hit.sections[0].children[0].children.map((n) => n.id), ['c1']);
});

test('filterTree 空查询原样返回', () => {
  const data = sample();
  assert.equal(Core.filterTree(data, '   '), data);
});

/* ------------------------------------------------------------ 规范化 */

test('normalizeData 补齐缺失字段、丢弃空节点、去重 id', () => {
  const { data, warnings } = Core.normalizeData({
    sections: [
      { id: 'dup', title: '一', children: [] },
      { id: 'dup', title: '二', children: [] },
      { title: '', children: [] },
      '纯字符串节点',
      null
    ]
  });
  assert.equal(data.version, Core.DATA_VERSION);
  assert.equal(data.title, '简历速取');
  assert.equal(data.sections.length, 3);
  const ids = data.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, 3, 'id 必须唯一');
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.ok(warnings.length >= 2);
});

test('normalizeData 容忍垃圾输入', () => {
  assert.equal(Core.normalizeData(null).data.sections.length, 0);
  assert.equal(Core.normalizeData('不是对象').data.sections.length, 0);
  assert.equal(Core.normalizeData([]).data.sections.length, 0);
  assert.equal(Core.normalizeData({ sections: {} }).data.sections.length, 0);
});

test('normalizeData 接受顶层数组简写', () => {
  const { data } = Core.normalizeData([{ title: '一', children: [{ title: 'A', value: 'va' }] }]);
  assert.equal(data.sections.length, 1);
  assert.equal(data.sections[0].children[0].value, 'va');
});

test('normalizeData 保留不认识的字段，导入导出无损', () => {
  const raw = {
    sections: [
      {
        id: 's',
        title: '一',
        tags: ['后端'],
        children: [{ id: 'x', title: 'X', value: 'v', pinned: true }]
      }
    ]
  };
  const { data } = Core.normalizeData(raw);
  assert.deepEqual(data.sections[0].tags, ['后端']);
  assert.equal(data.sections[0].children[0].pinned, true);
  assert.deepEqual(Core.normalizeData(JSON.parse(JSON.stringify(data))).data, data);
});

/* ------------------------------------------------------------ 示例数据 */

test('data/resume.example.json 结构合法且 id 唯一', () => {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const { data, warnings } = Core.normalizeData(raw);
  assert.deepEqual(warnings, [], '示例数据不应该有告警');

  const ids = [];
  Core.walk(data, (node) => ids.push(node.id));
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');

  const titles = data.sections.map((s) => s.title);
  assert.deepEqual(titles, ['基本信息', '教育经历', '工作经历', '项目经历', '专业技能']);
  assert.ok(Core.countNodes(data) > 25, '示例数据应该有足够多的条目');
});

test('示例数据能完整往返（写入 → 读回 → 结构不变）', () => {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const { data } = Core.normalizeData(raw);
  const roundTrip = Core.normalizeData(JSON.parse(JSON.stringify(data))).data;
  assert.deepEqual(roundTrip, data);
});
