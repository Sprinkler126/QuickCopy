/**
 * 简历速取 —— 页面逻辑。
 *
 * 交互约定：
 *   - 点卡片任意位置 = 复制（叶子卡复制内容；整段卡复制多行全文）
 *   - 卡头右侧小按钮：＋ 加子项 / ✎ 编辑 / 🗑 删除
 *   - 数据自动保存回服务端的默认 JSON 文件（900ms 防抖），也可手动保存
 */
(function () {
  'use strict';

  var Core = window.ResumeCore;
  var LS_COLLAPSED = 'quickcopy.collapsed';
  var LS_DENSITY = 'quickcopy.density';

  var state = {
    data: null,
    mtime: 0,
    path: '',
    dirty: false,
    saving: false,
    query: '',
    density: localStorage.getItem(LS_DENSITY) || 'normal',
    collapsed: readCollapsed(),
    editorId: null,
    dragId: null,
    dragChanged: false
  };

  var els = {};
  ['docTitle', 'dataPath', 'search', 'btnDensity', 'btnExpandAll', 'btnCollapseAll',
    'btnImport', 'btnExport', 'btnSave', 'saveState', 'fileInput', 'chipbar', 'board',
    'toast', 'banner', 'bannerText', 'bannerReload', 'bannerKeep', 'editor',
    'editorHeading', 'editTitle', 'editValue', 'editCopy', 'editorValueField',
    'editMoveUp', 'editMoveDown', 'editDelete', 'editCancel', 'editSave'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  /* ------------------------------------------------------------ 小工具 */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function iconBtn(act, id, glyph, title, extraClass) {
    var b = el('button', 'icon-btn' + (extraClass ? ' ' + extraClass : ''), glyph);
    b.type = 'button';
    b.dataset.act = act;
    b.dataset.id = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

  function readCollapsed() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch (e) {
      return new Set();
    }
  }

  function persistCollapsed() {
    try {
      localStorage.setItem(LS_COLLAPSED, JSON.stringify(Array.from(state.collapsed)));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  function countLeaves(node) {
    if (Core.isLeaf(node)) return 1;
    return node.children.reduce(function (sum, c) { return sum + countLeaves(c); }, 0);
  }

  function preview(text) {
    var t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > 44 ? t.slice(0, 44) + '…' : t;
  }

  var toastTimer = null;
  function toast(message, ms) {
    els.toast.hidden = false;
    els.toast.textContent = message;
    requestAnimationFrame(function () { els.toast.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
      setTimeout(function () { els.toast.hidden = true; }, 200);
    }, ms || 1800);
  }

  var stateTimer = null;
  function setSaveState(kind, text) {
    var labels = { idle: '已同步', dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' };
    els.saveState.className = 'save-state is-' + kind;
    els.saveState.textContent = text || labels[kind] || '';
    clearTimeout(stateTimer);
    if (kind === 'saved') {
      stateTimer = setTimeout(function () { setSaveState(state.dirty ? 'dirty' : 'idle'); }, 2000);
    }
  }

  /* --------------------------------------------------------------- 剪贴板 */

  function copy(text, label) {
    if (!text) { toast('这条是空的，没有可复制的内容'); return; }
    var done = function () {
      toast('已复制' + (label ? '「' + preview(label) + '」' : '') + '：' + preview(text));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  function legacyCopy(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    ta.remove();
  }

  /* ------------------------------------------------------------ 数据读写 */

  function applyPayload(payload) {
    state.data = payload.data;
    state.mtime = payload.mtime || 0;
    state.path = payload.path || state.path;
    (payload.warnings || []).forEach(function (w) { toast('数据提示：' + w, 3200); });
  }

  function loadFromServer() {
    return fetch('/api/data', { cache: 'no-store' })
      .then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
          return payload;
        });
      })
      .then(function (payload) {
        applyPayload(payload);
        hideBanner();
        state.dirty = false;
        setSaveState('idle');
        render();
      });
  }

  var saveTimer = null;
  function scheduleSave() {
    state.dirty = true;
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 900);
  }

  function saveNow() {
    if (!state.data) return Promise.resolve();
    if (state.saving) return Promise.resolve();
    clearTimeout(saveTimer);
    state.saving = true;
    setSaveState('saving');
    return fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.data)
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        // 服务端返回规范化后的数据；不重渲染，避免打断阅读位置
        state.data = payload.data;
        state.mtime = payload.mtime || 0;
        state.dirty = false;
        setSaveState('saved');
      });
    }).catch(function (err) {
      state.dirty = true;
      setSaveState('error', '保存失败');
      toast('保存失败：' + err.message, 4000);
    }).then(function () {
      state.saving = false;
    });
  }

  /** 任何改动都走这里：重新渲染 + 排队自动保存 */
  function mutate() {
    Core.touch(state.data);
    render();
    scheduleSave();
  }

  /* ------------------------------------------------------------- 外部改动 */

  function startWatching() {
    setInterval(function () {
      if (state.saving) return;
      fetch('/api/meta', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (meta) {
          if (!meta.mtime || meta.mtime === state.mtime) return;
          if (state.dirty) { showBanner('数据文件已被外部修改，但页面里还有未保存的改动。'); return; }
          return loadFromServer().then(function () {
            toast('检测到数据文件更新，已重新加载', 2200);
          });
        })
        .catch(function () { /* 服务没起来时静默 */ });
    }, 2500);
  }

  function showBanner(text) {
    els.bannerText.textContent = text;
    els.banner.hidden = false;
  }
  function hideBanner() { els.banner.hidden = true; }

  /* --------------------------------------------------------------- 渲染 */

  function render() {
    if (!state.data) return;
    els.docTitle.textContent = state.data.title || '简历速取';
    els.dataPath.textContent = state.path || '（未连接本地数据文件）';
    els.dataPath.title = state.path || '';
    renderChips();
    renderBoard();
  }

  function visibleData() {
    return Core.filterTree(state.data, state.query);
  }

  function renderChips() {
    var bar = els.chipbar;
    bar.textContent = '';
    visibleData().sections.forEach(function (section) {
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.dataset.target = 'sec-' + section.id;
      chip.appendChild(document.createTextNode(section.title || '(未命名)'));
      chip.appendChild(el('span', 'n', String(countLeaves(section))));
      bar.appendChild(chip);
    });
  }

  function renderBoard() {
    var board = els.board;
    board.textContent = '';
    if (!state.data) return;
    var view = visibleData();
    if (!view.sections.length) {
      board.appendChild(emptyState());
      return;
    }
    var frag = document.createDocumentFragment();
    view.sections.forEach(function (section) { frag.appendChild(renderSection(section)); });
    board.appendChild(frag);
    requestAnimationFrame(markOverflow);
  }

  function emptyState() {
    var box = el('div', 'empty');
    if (state.query) {
      box.textContent = '没有匹配「' + state.query + '」的内容';
      return box;
    }
    box.appendChild(el('p', null, '当前还没有任何内容。'));
    box.appendChild(el('p', null, '点右上角「导入」载入 JSON，或直接编辑数据文件后页面会自动刷新。'));
    var add = el('button', 'btn primary', '新增分类');
    add.type = 'button';
    add.addEventListener('click', function () { addSection(null); });
    box.appendChild(add);
    return box;
  }

  function renderSection(section) {
    var wrap = el('section', 'section' + (isCollapsed(section.id) ? ' collapsed' : ''));
    wrap.id = 'sec-' + section.id;
    wrap.dataset.id = section.id;

    var head = el('div', 'section-head');
    var chev = el('button', 'chev', '▾');
    chev.type = 'button';
    chev.dataset.collapse = section.id;
    chev.title = '折叠 / 展开';
    head.appendChild(chev);
    head.appendChild(el('h2', null, section.title || '(未命名分类)'));
    head.appendChild(el('span', 'section-count', countLeaves(section) + ' 项'));
    head.appendChild(el('span', 'spacer'));

    var actions = el('div', 'section-actions');
    actions.appendChild(iconBtn('add', section.id, '＋', '新增卡片'));
    actions.appendChild(iconBtn('addSection', section.id, '⊹', '在下方新增分类'));
    actions.appendChild(iconBtn('edit', section.id, '✎', '重命名分类'));
    actions.appendChild(iconBtn('del', section.id, '🗑', '删除分类', 'danger'));
    head.appendChild(actions);
    wrap.appendChild(head);

    var body = el('div', 'section-body grid');
    (section.children || []).forEach(function (child) { body.appendChild(renderNode(child, 1)); });
    wrap.appendChild(body);
    return wrap;
  }

  function renderNode(node, depth) {
    var leaf = Core.isLeaf(node);
    var card = el('article', 'card ' + (leaf ? 'card--leaf' : 'card--group') +
      (depth >= 2 ? ' card--nested' : ''));
    card.dataset.id = node.id;
    card.draggable = !state.query;
    card.title = state.query ? '搜索时不能调整顺序' : (leaf ? '拖拽卡片可调整同级顺序；点击复制内容' : '拖拽卡片可调整同级顺序；点标题复制名称，点其他位置复制整段');

    var head = el('div', 'card-head');
    var dragHandle = el('span', 'drag-handle', '⠿');
    dragHandle.title = state.query ? '清空搜索后可拖拽排序' : '拖拽调整同级顺序';
    dragHandle.setAttribute('aria-hidden', 'true');
    head.appendChild(dragHandle);
    if (!leaf) {
      var chev = el('button', 'chev', '▾');
      chev.type = 'button';
      chev.dataset.collapse = node.id;
      chev.title = '折叠 / 展开';
      head.appendChild(chev);
    }
    head.appendChild(el('h3', 'card-title', node.title || '(未命名)'));
    head.appendChild(el('span', 'spacer'));

    var actions = el('div', 'card-actions');
    if (!leaf) actions.appendChild(iconBtn('add', node.id, '＋', '在该条目下新增字段'));
    actions.appendChild(iconBtn('edit', node.id, '✎', '编辑'));
    actions.appendChild(iconBtn('del', node.id, '🗑', '删除', 'danger'));
    head.appendChild(actions);
    card.appendChild(head);

    var body = el('div', 'card-body');
    if (typeof node.value === 'string' && node.value !== '') {
      body.appendChild(el('p', 'card-value', node.value));
    }
    if (!leaf) {
      var grid = el('div', 'grid');
      node.children.forEach(function (child) { grid.appendChild(renderNode(child, depth + 1)); });
      body.appendChild(grid);
    }
    card.appendChild(body);

    if (isCollapsed(node.id) && !leaf) card.classList.add('collapsed');
    return card;
  }

  function markOverflow() {
    Array.prototype.forEach.call(els.board.querySelectorAll('.card'), function (card) {
      var value = card.querySelector(':scope > .card-body > .card-value');
      var btn = card.querySelector(':scope > .toggle-text');
      if (!value) { if (btn) btn.remove(); return; }
      var expanded = value.classList.contains('expanded');
      var overflowing = value.scrollHeight - value.clientHeight > 2;
      if (!expanded && !overflowing) { if (btn) btn.remove(); return; }
      if (!btn) {
        btn = el('button', 'toggle-text', '展开');
        btn.type = 'button';
        card.appendChild(btn);
      }
      btn.textContent = expanded ? '收起' : '展开';
      btn.hidden = false;
    });
  }

  function isCollapsed(id) {
    return !state.query && state.collapsed.has(id);
  }

  function toggleCollapse(id) {
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    persistCollapsed();
    if (state.query) { render(); return; }
    var collapsed = state.collapsed.has(id);
    var section = document.getElementById('sec-' + id);
    if (section && section.dataset.id === id) section.classList.toggle('collapsed', collapsed);
    Array.prototype.forEach.call(els.board.querySelectorAll('.card[data-id]'), function (card) {
      if (card.dataset.id === id) card.classList.toggle('collapsed', collapsed);
    });
    requestAnimationFrame(markOverflow);
  }

  /* --------------------------------------------------------------- 事件 */

  function onBoardClick(event) {
    if (state.dragChanged) {
      state.dragChanged = false;
      return;
    }
    var target = event.target;

    var collapseBtn = target.closest('.chev');
    if (collapseBtn) { toggleCollapse(collapseBtn.dataset.collapse); return; }

    var icon = target.closest('.icon-btn');
    if (icon) { handleAction(icon.dataset.act, icon.dataset.id); return; }

    var toggle = target.closest('.toggle-text');
    if (toggle) {
      var card = toggle.closest('.card');
      var value = card && card.querySelector(':scope > .card-body > .card-value');
      if (value) {
        value.classList.toggle('expanded');
        markOverflow();
      }
      return;
    }

    var head = target.closest('.section-head');
    if (head) { toggleCollapse(head.parentElement.dataset.id); return; }

    // 点整段卡片的标题 = 只复制名称（公司名 / 项目名）；点正文才是复制整段
    var titleEl = target.closest('.card-title');
    var owner = titleEl && titleEl.closest('.card');
    if (owner && owner.classList.contains('card--group')) {
      copyNodeTitle(owner.dataset.id);
      return;
    }

    var cardEl = target.closest('.card');
    if (cardEl) { copyNode(cardEl.dataset.id); }
  }

  /** 只复制这条经历 / 项目的名称，用来填「公司名称」「项目名称」这类单独的表单栏 */
  function copyNodeTitle(id) {
    var hit = Core.locate(state.data, id);
    if (!hit) return;
    copy(hit.node.title);
    flash(id);
  }

  function copyNode(id) {
    var hit = Core.locate(state.data, id);
    if (!hit) return;
    var node = hit.node;
    var leaf = Core.isLeaf(node);
    copy(leaf ? Core.copyText(node) : Core.collectCopyText(node), leaf ? node.title : null);
    flash(id);
  }

  function flash(id) {
    var cardEl = els.board.querySelector('.card[data-id="' + cssEscape(id) + '"]');
    if (!cardEl) return;
    cardEl.classList.add('copied');
    setTimeout(function () { cardEl.classList.remove('copied'); }, 420);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function clearDragIndicators() {
    Array.prototype.forEach.call(els.board.querySelectorAll('.dragging, .drop-before, .drop-after'), function (node) {
      node.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }

  function getDropTarget(event) {
    var target = event.target.closest('.card');
    if (!target || !state.dragId || target.dataset.id === state.dragId) return null;
    var source = Core.locate(state.data, state.dragId);
    var destination = Core.locate(state.data, target.dataset.id);
    if (!source || !destination || source.list !== destination.list) return null;
    var rect = target.getBoundingClientRect();
    return { card: target, after: event.clientY > rect.top + rect.height / 2 };
  }

  function onDragStart(event) {
    var card = event.target.closest('.card');
    if (!card || state.query || event.target.closest('button')) {
      event.preventDefault();
      return;
    }
    state.dragId = card.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragId);
    requestAnimationFrame(function () { card.classList.add('dragging'); });
  }

  function onDragOver(event) {
    var drop = getDropTarget(event);
    if (!drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDragIndicators();
    drop.card.classList.add(drop.after ? 'drop-after' : 'drop-before');
  }

  function onDrop(event) {
    var drop = getDropTarget(event);
    if (!drop) return;
    event.preventDefault();
    var moved = Core.reorderNode(state.data, state.dragId, drop.card.dataset.id, drop.after);
    clearDragIndicators();
    state.dragId = null;
    if (moved) {
      state.dragChanged = true;
      mutate();
      toast('已调整卡片顺序');
    }
  }

  function onDragEnd() {
    clearDragIndicators();
    state.dragId = null;
  }

  function handleAction(act, id) {
    if (act === 'add') { addChild(id); return; }
    if (act === 'addSection') { addSection(id); return; }
    if (act === 'edit') { openEditor(id); return; }
    if (act === 'del') { removeWithConfirm(id); return; }
  }

  function addChild(parentId) {
    var hit = Core.locate(state.data, parentId);
    if (!hit) return;
    var node = { id: Core.uid('n'), title: '新字段', value: '' };
    Core.insertNode(state.data, parentId, node);
    if (state.collapsed.has(parentId)) toggleCollapse(parentId);
    mutate();
    openEditor(node.id);
  }

  function addSection(afterId) {
    var section = { id: Core.uid('sec'), title: '新分类', children: [] };
    var index = null;
    if (afterId) {
      var current = (state.data.sections || []).findIndex(function (s) { return s.id === afterId; });
      if (current >= 0) index = current + 1;
    }
    Core.insertNode(state.data, '__root__', section, index);
    mutate();
    openEditor(section.id);
  }

  function removeWithConfirm(id) {
    var hit = Core.locate(state.data, id);
    if (!hit) return;
    var label = hit.node.title || '(未命名)';
    var extra = Core.isLeaf(hit.node) ? '' : '（连同它的 ' + hit.node.children.length + ' 个子项一起）';
    if (!window.confirm('确定删除「' + label + '」' + extra + '吗？')) return;
    Core.removeNode(state.data, id);
    state.collapsed.delete(id);
    persistCollapsed();
    mutate();
    toast('已删除：' + preview(label));
  }

  /* --------------------------------------------------------------- 编辑 */

  function openEditor(id) {
    var hit = Core.locate(state.data, id);
    if (!hit) return;
    state.editorId = id;
    var node = hit.node;
    var isSection = hit.parent === null;
    els.editorHeading.textContent = isSection ? '编辑分类'
      : (Core.isLeaf(node) ? '编辑字段' : '编辑条目');
    els.editTitle.value = node.title || '';
    els.editValue.value = node.value || '';
    els.editCopy.value = node.copy || '';
    els.editorValueField.hidden = isSection;
    if (!els.editor.open) els.editor.showModal();
    // 已有内容时把光标送到正文，方便直接改文案；新建时先让用户填标题
    if (node.value) els.editValue.focus();
    else { els.editTitle.focus(); els.editTitle.select(); }
  }

  function closeEditor() {
    state.editorId = null;
    if (els.editor.open) els.editor.close();
  }

  function commitEditor() {
    var hit = Core.locate(state.data, state.editorId);
    if (!hit) { closeEditor(); return; }
    var node = hit.node;
    var title = els.editTitle.value.trim();
    if (title) node.title = title;
    if (!els.editorValueField.hidden) {
      var value = els.editValue.value;
      if (value) node.value = value; else delete node.value;
    }
    var custom = els.editCopy.value.trim();
    if (custom) node.copy = custom; else delete node.copy;
    closeEditor();
    mutate();
    toast('已更新：' + preview(node.title));
  }

  function editorMove(delta) {
    if (!state.editorId) return;
    if (Core.moveNode(state.data, state.editorId, delta)) mutate();
    else toast(delta < 0 ? '已经在最前面了' : '已经在最后面了');
  }

  /* ------------------------------------------------------------ 导入导出 */

  function exportJson() {
    var text = JSON.stringify(state.data, null, 2);
    var blob = new Blob([text + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    var a = el('a');
    a.href = url;
    a.download = 'resume-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 JSON 文件');
  }

  function importJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (err) {
        toast('导入失败：不是合法的 JSON（' + err.message + '）', 4200);
        return;
      }
      var result = Core.normalizeData(raw);
      if (!window.confirm('导入将替换当前 ' + Core.countNodes(state.data) + ' 个条目（原文件会先备份到 data/backups/）。继续？')) return;
      state.data = result.data;
      state.collapsed.clear();
      persistCollapsed();
      (result.warnings || []).forEach(function (w) { toast('导入提示：' + w, 3200); });
      mutate();
      saveNow().then(function () { toast('已导入 ' + Core.countNodes(state.data) + ' 个条目'); });
    };
    reader.readAsText(file, 'utf-8');
  }

  /* --------------------------------------------------------------- 绑定 */

  function bind() {
    els.board.addEventListener('click', onBoardClick);
    els.board.addEventListener('dragstart', onDragStart);
    els.board.addEventListener('dragover', onDragOver);
    els.board.addEventListener('drop', onDrop);
    els.board.addEventListener('dragend', onDragEnd);
    els.chipbar.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      var target = document.getElementById(chip.dataset.target);
      if (!target) return;
      if (target.classList.contains('collapsed')) toggleCollapse(chip.dataset.target.slice(4));
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    var searchTimer = null;
    els.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = els.search.value;
        renderChips();
        renderBoard();
      }, 130);
    });

    els.btnDensity.addEventListener('click', function () {
      state.density = state.density === 'compact' ? 'normal' : 'compact';
      localStorage.setItem(LS_DENSITY, state.density);
      applyDensity();
      requestAnimationFrame(markOverflow);
    });

    els.btnExpandAll.addEventListener('click', function () {
      state.collapsed.clear();
      persistCollapsed();
      render();
    });

    els.btnCollapseAll.addEventListener('click', function () {
      state.collapsed.clear();
      Core.walk(state.data, function (node) {
        if (!Core.isLeaf(node)) state.collapsed.add(node.id);
      });
      persistCollapsed();
      render();
    });

    els.btnSave.addEventListener('click', saveNow);
    els.btnExport.addEventListener('click', exportJson);
    els.btnImport.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      if (file) importJsonFile(file);
      els.fileInput.value = '';
    });

    els.dataPath.addEventListener('click', function () {
      if (!state.path) return;
      copy(state.path, '数据文件路径');
    });

    els.bannerReload.addEventListener('click', function () {
      loadFromServer().then(function () { toast('已加载磁盘上的最新数据'); });
    });
    els.bannerKeep.addEventListener('click', function () {
      hideBanner();
      // 保留本地改动：把当前状态直接写回磁盘
      state.dirty = true;
      scheduleSave();
    });

    els.editSave.addEventListener('click', commitEditor);
    els.editCancel.addEventListener('click', closeEditor);
    els.editDelete.addEventListener('click', function () {
      var id = state.editorId;
      closeEditor();
      removeWithConfirm(id);
    });
    els.editMoveUp.addEventListener('click', function () { editorMove(-1); });
    els.editMoveDown.addEventListener('click', function () { editorMove(1); });
    els.editor.addEventListener('cancel', function () { state.editorId = null; });

    document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || event.target.isContentEditable;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        els.search.focus();
      } else if (event.key === 'Escape' && event.target === els.search) {
        els.search.value = '';
        state.query = '';
        renderChips();
        renderBoard();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNow();
      }
    });

    var topbar = document.querySelector('.topbar');
    var syncHeight = function () {
      document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
    };
    syncHeight();
    window.addEventListener('resize', syncHeight);
    if (window.ResizeObserver) new ResizeObserver(syncHeight).observe(topbar);

    window.addEventListener('beforeunload', function (event) {
      if (state.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  function applyDensity() {
    document.body.dataset.density = state.density;
    els.btnDensity.textContent = state.density === 'compact' ? '紧凑模式 ✓' : '紧凑模式';
    els.btnDensity.classList.toggle('on', state.density === 'compact');
  }

  function renderOffline(err) {
    els.board.textContent = '';
    var box = el('div', 'empty');
    box.appendChild(el('p', null, '读不到本地数据文件。'));
    var p = el('p');
    p.appendChild(document.createTextNode('请用自带的本地服务打开本页：在项目目录执行 '));
    p.appendChild(el('code', null, 'node server.js'));
    p.appendChild(document.createTextNode('，再访问 '));
    p.appendChild(el('code', null, 'http://127.0.0.1:5178/'));
    p.appendChild(document.createTextNode('。'));
    box.appendChild(p);
    box.appendChild(el('p', null, '错误：' + err.message));
    els.board.appendChild(box);
    els.saveState.textContent = '未连接';
    els.saveState.className = 'save-state is-error';
  }

  function boot() {
    bind();
    applyDensity();
    loadFromServer()
      .then(function () {
        startWatching();
      })
      .catch(function (err) {
        renderOffline(err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
