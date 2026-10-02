// ==UserScript==
// @name         巨潮资讯 PDF 直链打开 (支持港A股)
// @namespace    http://tampermonkey.net/
// @version      4.3.4
// @updateURL https://raw.githubusercontent.com/zh-zxc/cninfo-pdf-direct/main/cninfo-pdf-direct.user.js
// @downloadURL https://raw.githubusercontent.com/zh-zxc/cninfo-pdf-direct/main/cninfo-pdf-direct.user.js
// @description  PDF 直链打开和本地自选股
// @author       zh-zxc
// @match        *://*.cninfo.com.cn/*
// @icon         https://static.cninfo.com.cn/new/assets/image/logo.png
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    function buildPdfUrl(href) {
        try {
            const url = new URL(href, window.location.origin);
            const announcementId = url.searchParams.get('announcementId');
            let announcementTime = url.searchParams.get('announcementTime');

            // 修复：港股 announcementTime 可能为 "YYYY-MM-DD HH:MM"，只取日期部分
            if (announcementTime) {
                announcementTime = announcementTime.split(' ')[0];
            }

            if (announcementId && announcementTime) {
                return `https://static.cninfo.com.cn/finalpage/${announcementTime}/${announcementId}.PDF`;
            }
        } catch (e) {
            console.log('[巨潮PDF直链] URL解析失败:', e);
        }
        return null;
    }

    const WATCHLIST_KEY = 'cninfo-pdf-direct-watchlist';
    const WATCHLIST_POSITION_KEY = 'cninfo-pdf-direct-watchlist-position';

    function getWatchlist() {
        const value = GM_getValue(WATCHLIST_KEY, []);
        if (!Array.isArray(value)) return [];
        return value.filter(item => item && typeof item.code === 'string' && typeof item.name === 'string');
    }

    function saveWatchlist(watchlist) {
        GM_setValue(WATCHLIST_KEY, watchlist);
    }

    function getWatchlistPosition() {
        const position = GM_getValue(WATCHLIST_POSITION_KEY, null);
        if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) {
            return null;
        }
        return position;
    }

    function createWatchlistPanel() {
        if (window.location.hostname !== 'www.cninfo.com.cn') return;

        GM_addStyle(`
            #cninfo-watchlist {
                position: fixed;
                top: 72px;
                right: 20px;
                z-index: 2147483647;
                width: 280px;
                color: #1f2937;
                background: #fff;
                border: 1px solid #dbe3ef;
                border-radius: 8px;
                box-shadow: 0 6px 24px rgba(15, 23, 42, .16);
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #cninfo-watchlist.is-collapsed .cninfo-watchlist-body { display: none; }
            .cninfo-watchlist-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 12px;
                color: #fff;
                background: #1677ff;
                border-radius: 8px 8px 0 0;
                font-weight: 600;
                cursor: grab;
                user-select: none;
            }
            .cninfo-watchlist-header.is-dragging {
                cursor: grabbing;
            }
            .cninfo-watchlist-header button {
                padding: 0 4px;
                color: #fff;
                background: transparent;
                border: 0;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
            }
            .cninfo-watchlist-body { padding: 10px; }
            .cninfo-watchlist-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; }
            .cninfo-watchlist-form input, #cninfo-watchlist-filter {
                box-sizing: border-box;
                min-width: 0;
                padding: 6px 8px;
                border: 1px solid #cbd5e1;
                border-radius: 4px;
                font: inherit;
            }
            .cninfo-watchlist-form button {
                padding: 0 10px;
                color: #fff;
                background: #1677ff;
                border: 0;
                border-radius: 4px;
                cursor: pointer;
            }
            .cninfo-watchlist-form button:hover { background: #0958d9; }
            #cninfo-watchlist-filter { width: 100%; margin-top: 8px; }
            .cninfo-watchlist-message {
                min-height: 20px;
                margin: 5px 0 0;
                color: #cf1322;
                font-size: 12px;
            }
            .cninfo-watchlist-items {
                max-height: 260px;
                margin: 2px 0 0;
                padding: 0;
                overflow-y: auto;
                list-style: none;
            }
            .cninfo-watchlist-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 7px 2px;
                border-bottom: 1px solid #f1f5f9;
            }
            .cninfo-watchlist-item-info { min-width: 0; }
            .cninfo-watchlist-item-link {
                display: block;
                min-width: 0;
                color: inherit;
                cursor: pointer;
                text-decoration: none;
            }
            .cninfo-watchlist-item-link:hover .cninfo-watchlist-item-name {
                color: #1677ff;
            }
            .cninfo-watchlist-item-name {
                display: block;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .cninfo-watchlist-item-code { color: #64748b; font-size: 12px; }
            .cninfo-watchlist-remove {
                flex: 0 0 auto;
                color: #64748b;
                background: transparent;
                border: 0;
                cursor: pointer;
            }
            .cninfo-watchlist-remove:hover { color: #cf1322; }
            .cninfo-watchlist-empty { padding: 12px 2px; color: #94a3b8; text-align: center; }
            .cninfo-watchlist-footer { margin-top: 8px; color: #94a3b8; font-size: 12px; }
        `);

        const panel = document.createElement('section');
        panel.id = 'cninfo-watchlist';
        panel.innerHTML = `
            <div class="cninfo-watchlist-header">
                <span>我的自选股</span>
                <button type="button" data-action="toggle" title="收起">−</button>
            </div>
            <div class="cninfo-watchlist-body">
                <form class="cninfo-watchlist-form">
                    <input name="name" maxlength="30" placeholder="股票名称（必填）" autocomplete="off" required>
                    <input name="code" maxlength="10" placeholder="股票代码（选填）" autocomplete="off">
                    <button type="submit">添加</button>
                </form>
                <div class="cninfo-watchlist-message" role="status"></div>
                <input id="cninfo-watchlist-filter" placeholder="筛选自选股" autocomplete="off">
                <ul class="cninfo-watchlist-items"></ul>
                <div class="cninfo-watchlist-footer">数据仅保存在当前浏览器</div>
            </div>
        `;
        document.body.appendChild(panel);
        const savedPosition = getWatchlistPosition();
        if (savedPosition) {
            panel.style.left = `${savedPosition.left}px`;
            panel.style.top = `${savedPosition.top}px`;
            panel.style.right = 'auto';
        }

        const $ = selector => panel.querySelector(selector);
        const header = $('.cninfo-watchlist-header');
        const form = $('.cninfo-watchlist-form');
        const codeInput = form.querySelector('[name="code"]');
        const nameInput = form.querySelector('[name="name"]');
        const filterInput = $('#cninfo-watchlist-filter');
        const message = $('.cninfo-watchlist-message');
        const items = $('.cninfo-watchlist-items');

        let dragState = null;
        header.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            dragState = {
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top
            };
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            header.classList.add('is-dragging');
            header.setPointerCapture(event.pointerId);
        });

        header.addEventListener('pointermove', event => {
            if (!dragState) return;
            const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
            const left = Math.min(maxLeft, Math.max(0, event.clientX - dragState.offsetX));
            const top = Math.min(maxTop, Math.max(0, event.clientY - dragState.offsetY));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        });

        function finishDragging(event) {
            if (!dragState) return;
            const rect = panel.getBoundingClientRect();
            GM_setValue(WATCHLIST_POSITION_KEY, { left: rect.left, top: rect.top });
            dragState = null;
            header.classList.remove('is-dragging');
            if (header.hasPointerCapture(event.pointerId)) {
                header.releasePointerCapture(event.pointerId);
            }
        }

        header.addEventListener('pointerup', finishDragging);
        header.addEventListener('pointercancel', finishDragging);

        function showMessage(text) {
            message.textContent = text;
            window.setTimeout(() => {
                if (message.textContent === text) message.textContent = '';
            }, 2500);
        }

        function element(tag, className, text) {
            const node = document.createElement(tag);
            node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function createWatchlistItem(item) {
            const row = element('li', 'cninfo-watchlist-item');
            const link = element('a', 'cninfo-watchlist-item-link');
            link.href = item.code
                ? `https://www.cninfo.com.cn/new/disclosure/stock?stockCode=${encodeURIComponent(item.code)}`
                : `https://www.cninfo.com.cn/new/fulltextSearch?keyWord=${encodeURIComponent(item.name)}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';

            const info = element('div', 'cninfo-watchlist-item-info');
            const name = element('span', 'cninfo-watchlist-item-name', item.name);
            name.title = item.name;
            const code = element('span', 'cninfo-watchlist-item-code', item.code || '代码未填写');
            info.append(name, code);
            link.append(info);

            const remove = element('button', 'cninfo-watchlist-remove', '删除');
            remove.type = 'button';
            remove.dataset.name = item.name;
            remove.dataset.code = item.code;
            row.append(link, remove);
            return row;
        }

        function renderItems() {
            const filter = filterInput.value.trim().toLowerCase();
            const watchlist = getWatchlist().filter(item =>
                item.code.toLowerCase().includes(filter) || item.name.toLowerCase().includes(filter)
            );
            if (watchlist.length === 0) {
                const empty = document.createElement('li');
                empty.className = 'cninfo-watchlist-empty';
                empty.textContent = filter ? '没有匹配的自选股' : '暂未添加自选股';
                items.replaceChildren(empty);
                return;
            }
            items.replaceChildren(...watchlist.map(createWatchlistItem));
        }

        form.addEventListener('submit', event => {
            event.preventDefault();
            const code = codeInput.value.trim().toUpperCase();
            const name = nameInput.value.trim();
            if (code && !/^[A-Z0-9.-]{1,10}$/.test(code)) {
                showMessage('请输入有效的股票代码');
                codeInput.focus();
                return;
            }
            if (!name) {
                showMessage('请输入股票名称');
                nameInput.focus();
                return;
            }
            const watchlist = getWatchlist();
            if (watchlist.some(item =>
                item.name.toLowerCase() === name.toLowerCase() || (code && item.code === code)
            )) {
                showMessage('该股票已经在自选中');
                return;
            }
            watchlist.push({ code, name });
            saveWatchlist(watchlist);
            form.reset();
            nameInput.focus();
            renderItems();
        });

        items.addEventListener('click', event => {
            const remove = event.target.closest('.cninfo-watchlist-remove');
            if (!remove) return;
            saveWatchlist(getWatchlist().filter(item =>
                item.name !== remove.dataset.name || item.code !== remove.dataset.code
            ));
            renderItems();
        });

        filterInput.addEventListener('input', renderItems);
        $('[data-action="toggle"]').addEventListener('click', event => {
            panel.classList.toggle('is-collapsed');
            event.currentTarget.textContent = panel.classList.contains('is-collapsed') ? '+' : '−';
            event.currentTarget.title = panel.classList.contains('is-collapsed') ? '展开' : '收起';
        });
        renderItems();
    }

    // 场景一：列表页点击拦截
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target.tagName !== 'A') {
            target = target.parentElement;
        }
        if (!target) return;

        const href = target.href;
        if (!href || !href.includes('/new/disclosure/detail')) return;

        const pdfUrl = buildPdfUrl(href);
        if (pdfUrl) {
            e.preventDefault();
            e.stopPropagation();
            console.log('[巨潮PDF直链] 点击拦截，打开:', pdfUrl);
            GM_openInTab(pdfUrl, { active: true });
        }
    }, true);

    // 场景二：直接打开详情页时自动跳转
    if (window.location.pathname.includes('/new/disclosure/detail')) {
        const pdfUrl = buildPdfUrl(window.location.href);
        if (pdfUrl) {
            console.log('[巨潮PDF直链] 详情页自动打开:', pdfUrl);
            GM_openInTab(pdfUrl, { active: true });
        }
    }

    createWatchlistPanel();
})();