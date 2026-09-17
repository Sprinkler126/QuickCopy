/**
 * ResumeCore —— 简历速取助手的纯逻辑层。
 *
 * 数据结构：所有内容都是一棵树上的节点
 *   node = { id, title, value?, copy?, children? }
 * - title  : 卡片标题 / 字段名（必填）
 * - value  : 卡片正文，点击即复制的内容
 * - copy   : 可选，自定义复制文本；缺省时复制 value，再缺省复制 title
 * - children: 下钻层级（父子关系）；同一 children 数组内的节点互为并列关系
 *
 * 根对象 = { version, title, updatedAt, sections: [section...] }
 * section 就是一个顶层节点（只有 id/title/children，没有 value）。
 *
 * 这个文件同时被浏览器（window.ResumeCore）和 Node（module.exports）加载，
 * 因此不能依赖任何 DOM / Node API。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ResumeCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DATA_VERSION = 1;

  /* ---------------------------------------------------------------- 基础 */

  function isLeaf(node) {
    return !node || !Array.isArray(node.children) || node.children.length === 0;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  var idSeq = 0;
  function uid(prefix) {
    idSeq += 1;
    return (prefix || 'n') + '_' + Date.now().toString(36) + idSeq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  /** 叶子节点点击后真正写进剪贴板的文本 */
  function copyText(node) {
    if (!node) return '';
    if (typeof node.copy === 'string' && node.copy.length) return node.copy;
    if (typeof node.value === 'string' && node.value.length) return node.value;
    return typeof node.title === 'string' ? node.title : '';
  }

  /** 整张卡片（含全部后代）拼成的多行文本，用于「复制一整段经历」 */
  function collectCopyText(node) {
    if (!node) return '';
    if (isLeaf(node)) return copyText(node);
    var lines = [];
    if (node.title) lines.push(node.title);
    node.children.forEach(function (child) {
      if (isLeaf(child)) {
        lines.push(child.title ? child.title + '：' + copyText(child) : copyText(child));
      } else {
        lines.push(collectCopyText(child));
      }
    });
    return lines.filter(Boolean).join('\n');
  }

  /* ---------------------------------------------------------------- 遍历 */

  /** 深度优先遍历整棵树（含 sections 本身），visit(node, parentList, index, parentNode) */
  function walk(data, visit) {
    var sections = (data && data.sections) || [];
    for (var i = 0; i < sections.length; i++) {
      if (walkNode(sections[i], visit, sections, i, null) === false) return;
    }
  }

  function walkNode(node, visit, parentList, index, parentNode) {
    if (visit(node, parentList, index, parentNode) === false) return false;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (walkNode(kids[i], visit, kids, i, node) === false) return false;
    }
    return true;
  }

  /**
   * 定位节点：返回 { node, list, index, parent }，找不到返回 null。
   * list 是节点所在的数组（section 级别时为 data.sections）。
   */
  function locate(data, id) {
    var found = null;
    walk(data, function (node, list, index, parent) {
      if (node && node.id === id) {
        found = { node: node, list: list, index: index, parent: parent };
        return false;
      }
    });
    return found;
  }

  function countNodes(data) {
    var n = 0;
    walk(data, function () { n += 1; });
    return n;
  }

  /* ------------------------------------------------------------ 增删改查 */

  /** 在 parentId 之下插入；parentId 为 null/'__root__' 时插入顶层 section */
  function insertNode(data, parentId, node, index) {
    var list;
    if (!parentId || parentId === '__root__') {
      list = data.sections || (data.sections = []);
    } else {
      var hit = locate(data, parentId);
      if (!hit) return null;
      if (!Array.isArray(hit.node.children)) hit.node.children = [];
      list = hit.node.children;
    }
    if (typeof index !== 'number' || index < 0 || index > list.length) index = list.length;
    list.splice(index, 0, node);
    return node;
  }

  function removeNode(data, id) {
    var hit = locate(data, id);
    if (!hit) return null;
    hit.list.splice(hit.index, 1);
    return hit.node;
  }

  /** 同级内移动，delta 为 -1 / +1；返回是否真的移动了 */
  function moveNode(data, id, delta) {
    var hit = locate(data, id);
    if (!hit) return false;
    var target = hit.index + delta;
    if (target < 0 || target >= hit.list.length) return false;
    hit.list.splice(hit.index, 1);
    hit.list.splice(target, 0, hit.node);
    return true;
  }

  /**
   * 把节点拖到同级 targetId 的前面或后面。
   * 不允许跨父级移动，避免拖拽时意外改变简历的层级结构。
   */
  function reorderNode(data, id, targetId, placeAfter) {
    var source = locate(data, id);
    var target = locate(data, targetId);
    if (!source || !target || source === target || source.list !== target.list) return false;

    var from = source.index;
    var to = target.index + (placeAfter ? 1 : 0);
    if (from < to) to -= 1; // 删除源节点后，目标索引左移
    if (from === to) return false;
    source.list.splice(from, 1);
    source.list.splice(to, 0, source.node);
    return true;
  }

  /* ---------------------------------------------------------------- 搜索 */

  function matches(node, q) {
    var t = (node.title || '').toLowerCase();
    var v = (node.value || '').toLowerCase();
    return t.indexOf(q) >= 0 || v.indexOf(q) >= 0;
  }

  /**
   * 过滤出一棵只保留命中节点（及其祖先链）的新树。
   * 节点自身命中时保留它的整棵子树，便于一眼看全整段经历。
   */
  function filterTree(data, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return data;
    var out = [];
    ((data && data.sections) || []).forEach(function (section) {
      if (matches(section, q)) {
        out.push(section);
        return;
      }
      var kept = [];
      (section.children || []).forEach(function (child) {
        var hit = filterNode(child, q);
        if (hit) kept.push(hit);
      });
      if (kept.length) out.push(Object.assign({}, section, { children: kept }));
    });
    return Object.assign({}, data, { sections: out });
  }

  function filterNode(node, q) {
    if (matches(node, q)) return node;
    var kept = [];
    (node.children || []).forEach(function (child) {
      var hit = filterNode(child, q);
      if (hit) kept.push(hit);
    });
    if (!kept.length) return null;
    return Object.assign({}, node, { children: kept });
  }

  /* ------------------------------------------------------------ 校验/规范化 */

  /**
   * 把任意外来 JSON 收拾成合法数据。宽容处理：丢弃非法节点并记录 warning，
   * 缺 id 就补一个。返回 { data, warnings }。
   */
  function normalizeData(raw) {
    var warnings = [];
    if (Array.isArray(raw)) raw = { sections: raw };
    if (!isPlainObject(raw)) {
      return { data: emptyData(), warnings: ['数据不是对象，已重置为空模板'] };
    }
    var source = Array.isArray(raw.sections) ? raw.sections : null;
    if (!source) {
      warnings.push('找不到 sections 数组，已重置为空模板');
      source = [];
    }
    var seen = Object.create(null);
    var sections = [];
    source.forEach(function (item, i) {
      var node = normalizeNode(item, 'section ' + (i + 1), seen, warnings);
      if (node) sections.push(node);
    });
    var data = {
      version: DATA_VERSION,
      title: typeof raw.title === 'string' && raw.title ? raw.title : '简历速取',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      sections: sections
    };
    return { data: data, warnings: warnings };
  }

  function normalizeNode(item, where, seen, warnings) {
    if (typeof item === 'string') item = { title: item };
    if (!isPlainObject(item)) {
      warnings.push(where + '：不是对象，已忽略');
      return null;
    }
    var title = typeof item.title === 'string' ? item.title : '';
    var value = typeof item.value === 'string' ? item.value
      : (typeof item.value === 'number' ? String(item.value) : undefined);
    var children = [];
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) {
        warnings.push(where + '：children 不是数组，已忽略');
      } else {
        item.children.forEach(function (child, i) {
          var node = normalizeNode(child, where + ' > ' + (i + 1), seen, warnings);
          if (node) children.push(node);
        });
      }
    }
    if (!title && !value && !children.length) {
      warnings.push(where + '：既没有标题也没有内容，已忽略');
      return null;
    }
    var id = typeof item.id === 'string' && item.id && !seen[item.id] ? item.id : uid('n');
    seen[id] = true;
    var node = { id: id, title: title };
    if (value !== undefined) node.value = value;
    if (typeof item.copy === 'string' && item.copy) node.copy = item.copy;
    if (children.length) node.children = children;
    // 不认识的字段原样保留：导入 → 导出必须无损，用户手写的附加信息不能被吃掉
    Object.keys(item).forEach(function (key) {
      if (key !== 'id' && key !== 'title' && key !== 'value' && key !== 'copy' && key !== 'children') {
        node[key] = item[key];
      }
    });
    return node;
  }

  function emptyData() {
    return { version: DATA_VERSION, title: '简历速取', updatedAt: new Date().toISOString(), sections: [] };
  }

  function touch(data) {
    data.updatedAt = new Date().toISOString();
    return data;
  }

  return {
    DATA_VERSION: DATA_VERSION,
    isLeaf: isLeaf,
    uid: uid,
    copyText: copyText,
    collectCopyText: collectCopyText,
    walk: walk,
    locate: locate,
    countNodes: countNodes,
    insertNode: insertNode,
    removeNode: removeNode,
    moveNode: moveNode,
    reorderNode: reorderNode,
    filterTree: filterTree,
    normalizeData: normalizeData,
    emptyData: emptyData,
    touch: touch
  };
});
