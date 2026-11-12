/*
 * task-entry.js — TaskEntry（R03 空文档任务入口）
 *
 * 空文档（elements 为空）时在画布区显示任务卡片：
 *   从数据绘图（数据映射向导）/ 编辑已有 SVG（逐元素导入）/ 组合多张图（模板页）
 * 以及可直接打开的教学示例（examples/teaching/，经 /teaching/ 静态路由）。
 * 教学示例全部标注「演示数据」；文档一旦有元素即隐藏，不遮挡编辑。
 *
 *   TaskEntry.mount(stageEl)   幂等；监听 App doc:changed 控制显隐
 *   TaskEntry.refresh()        手动刷新（测试用）
 */
(function (global) {
  'use strict';

  var overlay = null;
  var teachingBox = null;
  var unsubs = [];
  var teachingLoaded = false;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          // 事件名大小写不敏感（onClick/onclick 均注册为 'click'）：
          // addEventListener 的事件类型是大小写敏感的
          el.addEventListener(String(k.slice(2)).toLowerCase(), v);
        } else el.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function docIsEmpty() {
    try {
      return !(global.App && global.App.doc &&
        Array.isArray(global.App.doc.elements) && global.App.doc.elements.length);
    } catch (e) { return true; }
  }

  function card(title, desc, buttonLabel, onClick, keyHint, pasteOption) {
    return h('div', {
      'data-task': title,
      style: 'flex:1 1 200px;min-width:200px;max-width:260px;border:1px solid #d5dbe3;' +
        'border-radius:8px;background:#fff;padding:14px;display:flex;flex-direction:column;gap:6px;'
    }, [
      h('div', { style: 'font-size:15px;font-weight:bold;color:#1f2937;', text: title }),
      h('div', { style: 'font-size:12px;color:#5b6472;line-height:1.5;', text: desc }),
      h('div', { style: 'flex:1;' }),
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
        h('button', {
          text: buttonLabel,
          style: 'padding:6px 14px;border-radius:5px;border:1px solid #1f6feb;' +
            'background:#1f6feb;color:#fff;cursor:pointer;font-size:13px;',
          onClick: function (evt) {
            try {
              onClick(evt);
            } catch (err) {
              // 不再静默失败：把原因显示出来
              if (global.Ui && typeof global.Ui.toast === 'function') {
                global.Ui.toast('操作失败：' + (err && err.message ? err.message : String(err)),
                  { type: 'error' });
              }
            }
          }
        }),
        pasteOption ? h('button', {
          'data-task-paste': '1',
          text: '粘贴数据',
          title: '不依赖文件选择框：直接粘贴 CSV/TSV/JSON 文本建图（受限窗口也可用）',
          style: 'padding:6px 12px;border-radius:5px;border:1px solid #c8d2dd;' +
            'background:#fff;color:#1f2937;cursor:pointer;font-size:12px;',
          onClick: function () {
            try {
              if (global.Import && typeof global.Import.openDataPaste === 'function') {
                global.Import.openDataPaste();
              } else {
                throw new Error('导入模块未提供粘贴入口（请刷新页面加载新版）');
              }
            } catch (err) {
              if (global.Ui && typeof global.Ui.toast === 'function') {
                global.Ui.toast('打开粘贴导入失败：' + err.message, { type: 'error' });
              }
            }
          }
        }) : null,
        keyHint ? h('span', { style: 'font-size:11px;color:#8a93a2;', text: keyHint }) : null
      ])
    ]);
  }

  function loadTeaching() {
    if (teachingLoaded || !teachingBox || typeof global.fetch !== 'function') return;
    teachingLoaded = true;
    global.fetch('teaching/index.json', { cache: 'no-store' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length || !teachingBox) return;
        list.slice(0, 6).forEach(function (item) {
          if (!item || !item.file) return;
          teachingBox.appendChild(h('button', {
            'data-teaching': item.file,
            title: (item.description || '') + '（演示工程：合成数据，可编辑可撤销）',
            style: 'padding:4px 10px;border:1px solid #c8d2dd;border-radius:5px;background:#fff;' +
              'cursor:pointer;font-size:12px;',
            text: (item.label || item.file) + '（演示）',
            onClick: function () { openTeaching(item.file); }
          }));
        });
      })
      .catch(function () { /* 教学示例不可用（如离线静态页）时保持隐藏 */ });
  }

  function openTeaching(file) {
    if (typeof global.fetch !== 'function') return;
    global.fetch('teaching/' + encodeURIComponent(file), { cache: 'no-store' })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('教学示例下载失败（HTTP ' + (r && r.status) + '）');
        return r.text();
      })
      .then(function (text) {
        if (typeof global.File === 'function') {
          return new global.File([text], file);
        }
        var blob = new global.Blob([text], { type: 'application/json' });
        blob.name = file;
        return blob;
      })
      .then(function (fileObj) {
        // 复用历史页的工程导入链（含确认、发布文档与历史恢复）
        if (global.History && typeof global.History.importProject === 'function') {
          return global.History.importProject(fileObj);
        }
        throw new Error('缺少 History.importProject，无法打开教学示例');
      })
      .catch(function (err) {
        if (global.Ui && typeof global.Ui.toast === 'function') {
          global.Ui.toast('打开教学示例失败：' + err.message, { type: 'error' });
        }
      });
  }

  function buildOverlay() {
    overlay = h('div', {
      id: 'task-entry-overlay',
      'data-empty-entry': 'true',
      style: 'position:absolute;inset:0;display:none;z-index:5;' +
        'align-items:center;justify-content:center;pointer-events:none;background:#eef4fb;'
    });
    var sheet = h('div', {
      style: 'pointer-events:auto;max-width:760px;width:calc(100% - 40px);padding:18px;'
    }, [
      h('div', {
        style: 'font-size:17px;font-weight:bold;color:#17325c;margin-bottom:4px;',
        text: '从这三步开始你的科研图'
      }),
      h('div', {
        style: 'font-size:12px;color:#5b6472;margin-bottom:14px;',
        text: '所有修改都会保留数据来源与历史；AI 修改先预览再应用。'
      }),
      h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;' }, [
        card('从数据绘图',
          '导入 CSV / JSON / Excel，经字段映射与统计含义确认后建图；原始数据保持不变。' +
          '窗口弹不出文件选择框时，用「粘贴数据」直接贴入。',
          '导入数据', function () {
            if (global.Import && typeof global.Import.openData === 'function') {
              global.Import.openData();
            } else {
              throw new Error('导入模块未加载（请刷新页面）');
            }
          }, null, true),
        card('编辑已有 SVG',
          '逐元素导入 SVG 图形/文字/路径，分别可编辑；或组合多张图排版论文图版。',
          '导入 SVG', function () {
            if (global.Import && typeof global.Import.openSvg === 'function') {
              global.Import.openSvg();
            }
          }),
        card('组合多张图',
          '选用多面板版式（2×2 等）与期刊尺寸模板，把多张图排成论文图版。',
          '浏览模板', function () {
            var tab = document.getElementById('tab-templates');
            if (tab) tab.click();
          })
      ]),
      h('div', {
        style: 'margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
      }, [
        h('span', {
          style: 'font-size:12px;color:#5b6472;',
          text: '教学示例（演示数据，非真实实验结果）：'
        }),
        teachingBox = h('span', {
          'data-teaching-list': 'true',
          style: 'display:flex;gap:6px;flex-wrap:wrap;'
        })
      ])
    ]);
    overlay.appendChild(sheet);
  }

  function refresh() {
    if (!overlay) return;
    var empty = docIsEmpty();
    overlay.style.display = empty ? 'flex' : 'none';
    if (empty) loadTeaching();
  }

  function mount(stageEl) {
    if (!stageEl || typeof stageEl.appendChild !== 'function') return;
    if (overlay && overlay.parentNode === stageEl) return;
    buildOverlay();
    stageEl.appendChild(overlay);
    unsubs.forEach(function (u) { try { u(); } catch (e) { /* noop */ } });
    unsubs = [];
    if (global.App && typeof global.App.on === 'function') {
      unsubs.push(global.App.on('doc:changed', refresh));
    }
    refresh();
  }

  global.TaskEntry = { mount: mount, refresh: refresh };
})(typeof globalThis !== 'undefined' ? globalThis : this);
