// ==UserScript==
// @name         巨潮资讯 PDF 直链打开 (支持港A股)
// @namespace    http://tampermonkey.net/
// @version      4.6.0
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

    const STORAGE = {
        watchlist: 'cninfo-pdf-direct-watchlist',
        position: 'cninfo-pdf-direct-watchlist-position'
    };
    const CNINFO = {
        api: '/new/information/topSearch/query',
        stockPath: '/new/disclosure/stock'
    };

    function getWatchlist() {
        const value = GM_getValue(STORAGE.watchlist, []);
        if (!Array.isArray(value)) return [];
        return value.filter(item =>
            item && typeof item.code === 'string' && typeof item.name === 'string'
        );
    }

    function saveWatchlist(watchlist) {
        GM_setValue(STORAGE.watchlist, watchlist);
    }

    function getWatchlistPosition() {
        const position = GM_getValue(STORAGE.position, null);
        if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) {
            return null;
        }
        return position;
    }

    async function searchStocks(keyword, signal) {
        const params = new URLSearchParams({ keyWord: keyword, maxNum: '10' });
        const response = await fetch(`${CNINFO.api}?${params}`, {
            method: 'POST',
            signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const results = await response.json();
        return Array.isArray(results) ? results : [];
    }

    function findStock(results, code, name) {
        return results.find(item =>
            (code && (item.code === code || item.secCode === code)) ||
            (!code && item.zwjc === name)
        );
    }

    function buildStockDetailUrl(stock) {
        const url = new URL(CNINFO.stockPath, window.location.origin);
        url.searchParams.set('tabName', 'data');
        url.searchParams.set('stockCode', stock.code);
        url.searchParams.set('orgId', stock.orgId);
        url.hash = 'latestAnnouncement';
        return url.href;
    }

    function createWatchlistPanel() {
        if (window.location.hostname !== 'www.cninfo.com.cn') return;

        GM_addStyle(`
            #cninfo-watchlist {
                position: fixed;
                top: 72px;
                right: 20px;
                z-index: 2147483647;
                width: min(330px, calc(100vw - 32px));
                overflow: hidden;
                color: #172033;
                background: #f8fafc;
                border: 1px solid #dbe4f0;
                border-radius: 14px;
                box-shadow: 0 14px 40px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .06);
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #cninfo-watchlist.is-collapsed .cninfo-watchlist-body { display: none; }
            .cninfo-watchlist-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 13px 15px;
                color: #fff;
                background: linear-gradient(135deg, #1769e0, #2f8cff);
                font-weight: 600;
                cursor: grab;
                user-select: none;
            }
            .cninfo-watchlist-header.is-dragging {
                cursor: grabbing;
            }
            .cninfo-watchlist-header button {
                width: 26px;
                height: 26px;
                color: #fff;
                background: rgba(255, 255, 255, .16);
                border: 1px solid rgba(255, 255, 255, .25);
                border-radius: 7px;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
            }
            .cninfo-watchlist-body { padding: 12px; }
            .cninfo-watchlist-form { position: relative; display: grid; grid-template-columns: 1fr 1fr auto; gap: 7px; }
            .cninfo-watchlist-form input, #cninfo-watchlist-filter {
                box-sizing: border-box;
                min-width: 0;
                padding: 8px 9px;
                color: inherit;
                background: #fff;
                border: 1px solid #d5deea;
                border-radius: 8px;
                font: inherit;
            }
            .cninfo-watchlist-form input:focus, #cninfo-watchlist-filter:focus, .cninfo-watchlist-sort:focus {
                outline: 2px solid rgba(47, 140, 255, .22);
                border-color: #2f8cff;
            }
            .cninfo-watchlist-form button {
                padding: 0 10px;
                color: #fff;
                background: #1769e0;
                border: 0;
                border-radius: 8px;
                cursor: pointer;
            }
            .cninfo-watchlist-form button:hover { background: #0958d9; }
            .cninfo-watchlist-suggestions {
                position: absolute;
                top: 35px;
                left: 0;
                z-index: 1;
                width: calc(50% - 3px);
                max-height: 220px;
                margin: 0;
                padding: 4px 0;
                overflow-y: auto;
                background: #fff;
                border: 1px solid #d5deea;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(15, 23, 42, .14);
                list-style: none;
            }
            .cninfo-watchlist-suggestions[hidden] { display: none; }
            .cninfo-watchlist-suggestion {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                width: 100%;
                padding: 7px 8px;
                color: #1f2937;
                background: #fff;
                border: 0;
                cursor: pointer;
                font: inherit;
                text-align: left;
            }
            .cninfo-watchlist-suggestion:hover { background: #eff6ff; }
            .cninfo-watchlist-suggestion-code { color: #64748b; font-size: 12px; }
            .cninfo-watchlist-tools { margin-top: 10px; }
            #cninfo-watchlist-filter { width: 100%; margin: 0; }
            .cninfo-watchlist-message {
                min-height: 20px;
                margin: 5px 2px 0;
                color: #cf1322;
                font-size: 12px;
            }
            .cninfo-watchlist-items {
                max-height: 260px;
                margin: 8px 0 0;
                padding: 4px 6px;
                overflow-y: auto;
                background: #fff;
                border: 1px solid #e2e8f0;
                border-radius: 10px;
                list-style: none;
            }
            .cninfo-watchlist-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 8px 4px;
                border-bottom: 1px solid #eef2f7;
            }
            .cninfo-watchlist-item:last-child { border-bottom: 0; }
            .cninfo-watchlist-item:hover { background: #f8fbff; }
            .cninfo-watchlist-item-info { overflow: hidden; min-width: 0; }
            .cninfo-watchlist-item-link { padding: 2px 4px; border-radius: 6px; }
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
            .cninfo-watchlist-item-link.is-loading { opacity: .6; }
            .cninfo-watchlist-item-name {
                display: block;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .cninfo-watchlist-item-code { color: #64748b; font-size: 12px; }
            .cninfo-watchlist-remove {
                flex: 0 0 auto;
                padding: 4px 6px;
                color: #94a3b8;
                background: transparent;
                border: 0;
                border-radius: 5px;
                cursor: pointer;
            }
            .cninfo-watchlist-remove:hover { color: #cf1322; background: #fff1f2; }
            .cninfo-watchlist-item-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
            .cninfo-watchlist-move {
                width: 24px;
                height: 24px;
                padding: 0;
                color: #64748b;
                background: transparent;
                border: 0;
                border-radius: 5px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
            }
            .cninfo-watchlist-move:hover:not(:disabled) { color: #1769e0; background: #eff6ff; }
            .cninfo-watchlist-move:disabled { color: #cbd5e1; cursor: default; }
            .cninfo-watchlist-empty { padding: 18px 2px; color: #94a3b8; text-align: center; }
            .cninfo-watchlist-footer { margin: 9px 2px 0; color: #94a3b8; font-size: 11px; }
            @media (max-width: 480px) {
                #cninfo-watchlist { top: 12px; right: 12px; }
            }
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
                    <ul class="cninfo-watchlist-suggestions" hidden></ul>
                </form>
                <div class="cninfo-watchlist-message" role="status"></div>
                <div class="cninfo-watchlist-tools">
                    <input id="cninfo-watchlist-filter" placeholder="筛选自选股" autocomplete="off">
                </div>
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
        const suggestions = $('.cninfo-watchlist-suggestions');
        let searchTimer = null;
        let searchController = null;
        let selectedOrgId = '';

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
            GM_setValue(STORAGE.position, { left: rect.left, top: rect.top });
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

        function hideSuggestions() {
            suggestions.replaceChildren();
            suggestions.hidden = true;
        }

        function renderSuggestions(results) {
            const matches = results.filter(item => item && item.code && item.orgId && item.zwjc).slice(0, 8);
            suggestions.replaceChildren(...matches.map(item => {
                const option = element('li', '');
                const button = element('button', 'cninfo-watchlist-suggestion');
                button.type = 'button';
                button.dataset.name = item.zwjc;
                button.dataset.code = item.code;
                button.dataset.orgId = item.orgId;
                const name = element('span', '', item.zwjc);
                const code = element('span', 'cninfo-watchlist-suggestion-code', item.code);
                option.append(button);
                button.append(name, code);
                return option;
            }));
            suggestions.hidden = matches.length === 0;
        }

        async function searchSuggestions(value) {
            if (searchController) searchController.abort();
            searchController = new AbortController();
            try {
                renderSuggestions(await searchStocks(value, searchController.signal));
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.log('[巨潮PDF直链] 自选股搜索失败:', error);
                    hideSuggestions();
                }
            }
        }

        nameInput.addEventListener('input', () => {
            const value = nameInput.value.trim();
            codeInput.value = '';
            selectedOrgId = '';
            if (searchTimer) window.clearTimeout(searchTimer);
            if (value.length < 1) {
                hideSuggestions();
                return;
            }
            searchTimer = window.setTimeout(() => searchSuggestions(value), 250);
        });

        codeInput.addEventListener('input', () => {
            selectedOrgId = '';
        });

        suggestions.addEventListener('click', event => {
            const option = event.target.closest('.cninfo-watchlist-suggestion');
            if (!option) return;
            nameInput.value = option.dataset.name;
            codeInput.value = option.dataset.code;
            selectedOrgId = option.dataset.orgId;
            hideSuggestions();
            codeInput.focus();
        });

        document.addEventListener('click', event => {
            if (!form.contains(event.target)) hideSuggestions();
        });

        function element(tag, className, text) {
            const node = document.createElement(tag);
            node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function createWatchlistItem(item, index, count) {
            const row = element('li', 'cninfo-watchlist-item');
            row.dataset.name = item.name;
            row.dataset.code = item.code;
            const link = element('a', 'cninfo-watchlist-item-link');
            link.href = '#';
            link.dataset.name = item.name;
            link.dataset.code = item.code;
            link.dataset.orgId = item.orgId || '';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';

            const info = element('div', 'cninfo-watchlist-item-info');
            const name = element('span', 'cninfo-watchlist-item-name', item.name);
            name.title = item.name;
            const code = element('span', 'cninfo-watchlist-item-code', item.code || '代码未填写');
            info.append(name, code);
            link.append(info);

            const actions = element('div', 'cninfo-watchlist-item-actions');
            const moveUp = element('button', 'cninfo-watchlist-move', '▲');
            moveUp.type = 'button';
            moveUp.title = '上移';
            moveUp.ariaLabel = `上移${item.name}`;
            moveUp.dataset.action = 'move-up';
            moveUp.disabled = index === 0;
            const moveDown = element('button', 'cninfo-watchlist-move', '▼');
            moveDown.type = 'button';
            moveDown.title = '下移';
            moveDown.ariaLabel = `下移${item.name}`;
            moveDown.dataset.action = 'move-down';
            moveDown.disabled = index === count - 1;
            const remove = element('button', 'cninfo-watchlist-remove', '删除');
            remove.type = 'button';
            remove.dataset.name = item.name;
            remove.dataset.code = item.code;
            actions.append(moveUp, moveDown, remove);
            row.append(link, actions);
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
            items.replaceChildren(...watchlist.map((item, index) =>
                createWatchlistItem(item, index, watchlist.length)
            ));
        }

        function moveWatchlistItem(row, direction) {
            const watchlist = getWatchlist();
            const visibleItems = [...items.querySelectorAll('.cninfo-watchlist-item')];
            const visibleIndex = visibleItems.indexOf(row);
            const targetIndex = visibleIndex + direction;
            if (visibleIndex < 0 || targetIndex < 0 || targetIndex >= visibleItems.length) return;
            const currentIndex = watchlist.findIndex(item =>
                item.name === row.dataset.name && item.code === row.dataset.code
            );
            const targetItem = visibleItems[targetIndex];
            const otherIndex = watchlist.findIndex(item =>
                item.name === targetItem.dataset.name && item.code === targetItem.dataset.code
            );
            if (currentIndex < 0 || otherIndex < 0) return;
            [watchlist[currentIndex], watchlist[otherIndex]] = [watchlist[otherIndex], watchlist[currentIndex]];
            saveWatchlist(watchlist);
            renderItems();
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
            watchlist.push({ code, name, orgId: selectedOrgId });
            saveWatchlist(watchlist);
            form.reset();
            selectedOrgId = '';
            nameInput.focus();
            renderItems();
        });

        items.addEventListener('click', event => {
            const row = event.target.closest('.cninfo-watchlist-item');
            const move = event.target.closest('.cninfo-watchlist-move');
            if (row && move) {
                moveWatchlistItem(row, move.dataset.action === 'move-up' ? -1 : 1);
                return;
            }
            const link = event.target.closest('.cninfo-watchlist-item-link');
            if (link) {
                event.preventDefault();
                openStockDetail(link);
                return;
            }
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

    async function openStockDetail(link) {
        if (link.classList.contains('is-loading')) return;
        link.classList.add('is-loading');
        try {
            let result = link.dataset.orgId
                ? { code: link.dataset.code, orgId: link.dataset.orgId }
                : null;
            if (!result) {
                const results = await searchStocks(link.dataset.code || link.dataset.name);
                result = findStock(results, link.dataset.code, link.dataset.name);
            }
            if (!result || !result.code || !result.orgId) {
                throw new Error('未找到对应上市公司');
            }
            GM_openInTab(buildStockDetailUrl(result), { active: true });
        } catch (error) {
            console.log('[巨潮PDF直链] 自选股详情解析失败:', error);
            window.alert('未找到该股票的详情信息，请检查股票名称或代码');
        } finally {
            link.classList.remove('is-loading');
        }
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