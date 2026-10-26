// ==UserScript==
// @name         巨潮资讯 PDF 直链打开 (支持港A股)
// @namespace    http://tampermonkey.net/
// @version      5.2.0
// @description  公告直开 PDF；板块识别与筛选、快速搜索、自选整理、撤销备份、迷你面板与主题
// @author       zh-zxc
// @match        *://*.cninfo.com.cn/*
// @icon         https://static.cninfo.com.cn/new/assets/image/logo.png
// @run-at       document-idle
// @noframes
// @updateURL    none
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE = {
        watchlist: 'cninfo-pdf-direct-watchlist',
        position: 'cninfo-pdf-direct-watchlist-position',
        collapsed: 'cninfo-pdf-direct-watchlist-collapsed',
        settings: 'cninfo-pdf-direct-settings',
        board: 'cninfo-pdf-direct-board-filter',
        backup: 'cninfo-pdf-direct-watchlist-backup-v4'
    };
    const DEFAULT_SETTINGS = { background: false, autoRedirect: true, theme: 'system', compact: false };
    const MAX_ITEMS = 2000;
    const PAGE_SIZE = 60;
    const BOARDS = {
        sh_main: { id: 'sh_main', label: '沪市主板' },
        sz_main: { id: 'sz_main', label: '深市主板' },
        star: { id: 'star', label: '科创板' },
        gem: { id: 'gem', label: '创业板' },
        hk: { id: 'hk', label: '港股' },
        other: { id: 'other', label: '其他/未识别' }
    };
    const BOARD_FILTERS = { all: '全部板块', main: '全部主板', ...Object.fromEntries(Object.values(BOARDS).map(board => [board.id, board.label])) };
    // 仅在没有市场信息时，用港交所股票/GEM 常见区间推断；不把所有五位代码都当股票。
    const HK_EQUITY_RANGES = [[1, 2799], [2850, 2999], [3200, 3399], [3600, 3999], [6030, 6199],
        [6600, 6749], [6800, 6999], [7400, 7499], [7600, 7699], [7800, 8999], [9600, 9699], [9850, 9999],
        [80001, 82799], [82850, 82999], [83200, 83399], [83600, 83999], [86030, 86199],
        [86800, 86999], [87400, 87499], [87600, 87699], [89600, 89699], [89850, 89999]];
    const searchCache = new Map();
    let watchlistCache = null;
    let writeQueue = Promise.resolve();

    function read(key, fallback) {
        try { return GM_getValue(key, fallback); }
        catch (error) {
            console.warn('[巨潮PDF直链] 读取设置失败', error);
            return fallback;
        }
    }

    function getSettings() {
        const saved = read(STORAGE.settings, {});
        return {
            background: typeof saved?.background === 'boolean' ? saved.background : DEFAULT_SETTINGS.background,
            autoRedirect: typeof saved?.autoRedirect === 'boolean' ? saved.autoRedirect : DEFAULT_SETTINGS.autoRedirect,
            theme: ['system', 'light', 'dark'].includes(saved?.theme) ? saved.theme : DEFAULT_SETTINGS.theme,
            compact: typeof saved?.compact === 'boolean' ? saved.compact : DEFAULT_SETTINGS.compact
        };
    }

    function normalizeStock(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        if (item.code !== undefined && typeof item.code !== 'string') return null;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        const code = typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
        if (!name || name.length > 80 || (code && !/^[A-Z0-9.-]{1,16}$/.test(code))) return null;
        const orgId = typeof item.orgId === 'string' && /^[\w.-]{1,80}$/.test(item.orgId) ? item.orgId : '';
        const stock = { name, code, orgId };
        if (typeof item.market === 'string' && item.market.trim()) stock.market = item.market.trim().slice(0, 20);
        if (typeof item.pinyin === 'string' && /^[a-z]{1,80}$/i.test(item.pinyin)) stock.pinyin = item.pinyin.toLowerCase();
        return stock;
    }

    function sameStock(a, b) {
        if (a.code && b.code) {
            return a.code === b.code && (!a.orgId || !b.orgId || a.orgId === b.orgId);
        }
        return !a.code && !b.code && a.name.toLowerCase() === b.name.toLowerCase();
    }

    function stockKey(stock) { return JSON.stringify([stock.code, stock.orgId || '', stock.code ? '' : stock.name.toLowerCase()]); }

    function classifyBoard(stock) {
        const code = typeof stock.code === 'string' ? stock.code.trim() : '';
        const market = stock.market || '';
        // API 明确给出的非股票产品类别优先，避免指数/基金与 A 股代码重号。
        if (/基金|债|債|指数|指數|权证|權證|期货|期貨|期权|期權|ETF|ETN|REIT/i.test(market)) return BOARDS.other;
        if (/港股|香港/.test(market)) return BOARDS.hk;
        if (/^\d{5}$/.test(code)) {
            const number = Number(code);
            return !market && HK_EQUITY_RANGES.some(([start, end]) => number >= start && number <= end) ? BOARDS.hk : BOARDS.other;
        }
        if (market && !/A股|Ａ股|股票|存托凭证|存託憑證|主板|科创板|科創板|创业板|創業板|沪A|深A/.test(market)) return BOARDS.other;
        if (/^(688|689)\d{3}$/.test(code)) return BOARDS.star;
        if (/^30\d{4}$/.test(code)) return BOARDS.gem;
        if (/^(600|601|603|605)\d{3}$/.test(code)) return BOARDS.sh_main;
        if (/^00[0-4]\d{3}$/.test(code)) return BOARDS.sz_main;
        // A/H 两地上市可能共用 gshk 公司 ID（如 688981），不能据此覆盖六位 A 股代码。
        if (!market && /^\d{1,4}$/.test(code) && /^gshk/i.test(stock.orgId || '')) return BOARDS.hk;
        return BOARDS.other;
    }

    function matchesBoard(stock, selected) {
        const board = classifyBoard(stock).id;
        return selected === 'all' || board === selected || (selected === 'main' && (board === 'sh_main' || board === 'sz_main'));
    }

    // O(n) 建索引，保留同代码不同 orgId 的证券，兼容旧版缺 orgId 的条目。
    function createStockIndex() {
        const groups = new Map();
        const key = stock => stock.code ? `code:${stock.code}` : `name:${stock.name.toLowerCase()}`;
        return {
            find(stock) {
                const group = groups.get(key(stock));
                if (!group) return -1;
                if (!stock.code || !stock.orgId) return group.first;
                return group.orgs.get(stock.orgId) ?? group.orgs.get('') ?? -1;
            },
            add(stock, index) {
                const groupKey = key(stock);
                if (!groups.has(groupKey)) groups.set(groupKey, { first: index, orgs: new Map() });
                groups.get(groupKey).orgs.set(stock.orgId || '', index);
            },
            upgrade(previous, stock, index) {
                const group = groups.get(key(previous));
                group.orgs.delete(previous.orgId || '');
                group.orgs.set(stock.orgId || '', index);
            }
        };
    }

    function normalizeList(value) {
        if (!Array.isArray(value)) return [];
        const result = [];
        const index = createStockIndex();
        for (const raw of value) {
            const stock = normalizeStock(raw);
            if (!stock) continue;
            const existing = index.find(stock);
            if (existing < 0) { index.add(stock, result.length); result.push(stock); }
            else if (!result[existing].orgId && stock.orgId) {
                index.upgrade(result[existing], stock, existing);
                result[existing] = { ...result[existing], orgId: stock.orgId };
            }
        }
        return result;
    }

    function readWatchlistRaw() {
        let raw;
        try { raw = GM_getValue(STORAGE.watchlist, []); }
        catch { throw new Error('无法读取自选股，请检查扩展存储后重试'); }
        if (!Array.isArray(raw)) throw new Error('自选股存储格式异常，请先导出原始备份后修复');
        return raw;
    }

    function invalidateWatchlist() { watchlistCache = null; }

    function getWatchlist(fresh = false) {
        if (fresh || !watchlistCache) watchlistCache = normalizeList(readWatchlistRaw());
        return watchlistCache.map(item => ({ ...item }));
    }

    function saveWatchlist(list) {
        // 首次改动前保留旧版本数据；继续使用原存储键，不迁移或清空自选股。
        if (GM_getValue(STORAGE.backup, null) === null) {
            GM_setValue(STORAGE.backup, GM_getValue(STORAGE.watchlist, []));
        }
        GM_setValue(STORAGE.watchlist, list);
        invalidateWatchlist();
    }

    function updateWatchlist(edit) {
        const execute = () => {
            const raw = readWatchlistRaw();
            if (raw.some(item => !normalizeStock(item))) {
                throw new Error('收藏中存在损坏条目，请先导出原始备份后修复；本次未写入');
            }
            const change = edit(normalizeList(raw));
            if (change.list) {
                if (change.list.length > Math.max(MAX_ITEMS, raw.length)) throw new Error(`最多支持 ${MAX_ITEMS} 条自选股`);
                saveWatchlist(change.list);
            }
            return change.value;
        };
        // 同一页面排队；支持 Web Locks 的同源标签页共享锁，在锁内重新读最新数据。
        const operation = () => typeof navigator !== 'undefined' && navigator.locks?.request
            ? navigator.locks.request(`${STORAGE.watchlist}:write`, execute)
            : execute();
        const result = writeQueue.then(operation);
        writeQueue = result.catch(() => {});
        return result;
    }

    function parseImport(text) {
        const data = JSON.parse(text.replace(/^\uFEFF/, ''));
        const source = Array.isArray(data) ? data : data?.watchlist;
        if (!Array.isArray(source)) throw new Error('文件中没有自选股数组');
        if (source.length > MAX_ITEMS) throw new Error(`单个文件最多支持 ${MAX_ITEMS} 条`);
        if (source.some(item => !normalizeStock(item))) throw new Error('文件包含无效条目，未导入任何数据');
        return normalizeList(source);
    }

    function mergeWatchlist(current, incoming) {
        const list = current.map(item => ({ ...item }));
        const index = createStockIndex();
        list.forEach((item, i) => index.add(item, i));
        let added = 0;
        let updated = 0;
        for (const stock of incoming) {
            const found = index.find(stock);
            const existing = list[found];
            if (!existing) { index.add(stock, list.length); list.push({ ...stock }); added++; }
            else {
                const enriched = { ...existing };
                for (const field of ['orgId', 'market', 'pinyin']) if (!enriched[field] && stock[field]) enriched[field] = stock[field];
                if (JSON.stringify(enriched) !== JSON.stringify(existing)) {
                    index.upgrade(existing, enriched, found);
                    list[found] = enriched;
                    updated++;
                }
            }
        }
        if (list.length > Math.max(MAX_ITEMS, current.length)) throw new Error(`自选股总数不能超过 ${MAX_ITEMS} 条`);
        return { list, added, updated };
    }

    function buildPdfUrl(href) {
        try {
            const url = new URL(href, window.location.origin);
            if (!/^https?:$/.test(url.protocol) || !/(^|\.)cninfo\.com\.cn$/i.test(url.hostname)) return null;
            if (!/^\/new\/disclosure\/detail\/?$/.test(url.pathname)) return null;
            const id = url.searchParams.get('announcementId');
            const time = url.searchParams.get('announcementTime') || '';
            const match = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(time.trim());
            if (!id || !/^\d{1,30}$/.test(id) || !match) return null;
            const date = new Date(`${match[1]}T00:00:00Z`);
            if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return null;
            return `https://static.cninfo.com.cn/finalpage/${match[1]}/${id}.PDF`;
        } catch { return null; }
    }

    function buildStockDetailUrl(stock) {
        if (!stock.code || !stock.orgId) throw new Error('股票信息不完整，请重新搜索');
        const url = new URL('/new/disclosure/stock', window.location.origin);
        url.searchParams.set('tabName', 'data');
        url.searchParams.set('stockCode', stock.code);
        url.searchParams.set('orgId', stock.orgId);
        url.hash = 'latestAnnouncement';
        return url.href;
    }

    function normalizeSearchResults(data) {
        if (!Array.isArray(data)) throw new Error('搜索服务返回格式异常，请稍后重试');
        return normalizeList(data.map(item => ({
            name: item?.zwjc || item?.secName || item?.name,
            code: item?.code || item?.secCode,
            orgId: item?.orgId, market: item?.category, pinyin: item?.pinyin
        }))).filter(item => item.code && item.orgId).slice(0, 10);
    }

    async function searchStocks(keyword, signal) {
        if (signal?.aborted) throw new DOMException('搜索已取消', 'AbortError');
        const key = keyword.trim().toLowerCase();
        const cached = searchCache.get(key);
        if (cached && Date.now() - cached.time < 60000) return cached.items;
        const controller = new AbortController();
        let timedOut = false;
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
        try {
            const params = new URLSearchParams({ keyWord: keyword.trim(), maxNum: '10' });
            const response = await fetch(`/new/information/topSearch/query?${params}`, {
                method: 'POST', credentials: 'same-origin', signal: controller.signal
            });
            if (!response.ok) throw new Error(`搜索服务暂不可用（HTTP ${response.status}）`);
            const items = normalizeSearchResults(await response.json());
            if (controller.signal.aborted) throw new DOMException('搜索已取消', 'AbortError');
            searchCache.delete(key);
            searchCache.set(key, { time: Date.now(), items });
            if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
            return items;
        } catch (error) {
            if (timedOut) throw new Error('搜索超时，请重试或使用手动添加');
            throw error;
        } finally {
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    function findExactStock(results, item) {
        const matches = results.filter(stock => item.code ? stock.code === item.code : stock.name === item.name);
        return matches.length === 1 ? matches[0] : null;
    }

    function shouldOpenActive(event) {
        return event?.shiftKey || !(event?.ctrlKey || event?.metaKey || event?.button === 1 || getSettings().background);
    }

    function openTab(url, active = true) {
        GM_openInTab(url, { active, insert: true, setParent: true });
    }

    function handlePdfClick(event) {
        if (event.defaultPrevented || (event.type === 'click' && event.button !== 0) ||
            (event.type === 'auxclick' && event.button !== 1)) return;
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor || anchor.hasAttribute('download')) return;
        const pdfUrl = buildPdfUrl(anchor.href);
        if (!pdfUrl) return;
        const detail = new URL(anchor.href);
        if (detail.searchParams.get('cninfoOriginal') === '1') return;
        if (event.altKey) detail.searchParams.set('cninfoOriginal', '1');
        event.preventDefault();
        event.stopImmediatePropagation();
        openTab(event.altKey ? detail.href : pdfUrl, shouldOpenActive(event));
    }

    const STYLE = `
        :host{all:initial;position:fixed;top:76px;right:20px;z-index:2147483647;width:min(352px,calc(100vw - 24px));color-scheme:light;--blue:#2463eb;--ink:#1c2941;--muted:#68778f;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink)}
        *{box-sizing:border-box} [hidden]{display:none!important} button,input,summary{font:inherit} button{cursor:pointer} button:disabled{cursor:default;opacity:.45} a{color:inherit;text-decoration:none} button,a,input,summary{outline-offset:3px} :focus-visible{outline:2px solid #6398ff}
        .panel{overflow:hidden;border:1px solid #dbe4f0;border-radius:16px;background:#f7f9fd;box-shadow:0 12px 38px #16325429,0 2px 8px #1632540a}
        header{display:flex;align-items:center;gap:8px;padding:12px 14px;color:white;background:linear-gradient(120deg,#215cdb,#3986f7);user-select:none;touch-action:none;cursor:grab}
        header.dragging{cursor:grabbing} .title{font-weight:650;font-size:15px;letter-spacing:.3px} .count{border-radius:20px;padding:1px 7px;background:#ffffff26;font-size:11px} .spacer{flex:1}
        .icon{display:grid;place-items:center;width:28px;height:28px;border:1px solid #ffffff35;border-radius:8px;color:inherit;background:#ffffff16;font-size:18px} .icon:hover{background:#ffffff30}
        .body{max-height:calc(100dvh - 96px);max-height:var(--body-height,calc(100vh - 150px));overflow:auto;padding:14px}
        .caption{display:block;margin-bottom:7px;color:var(--muted);font-size:12px} .search-form{display:flex;gap:7px} .search-wrap{position:relative;flex:1;min-width:0}
        input[type=text],input[type=search]{width:100%;min-width:0;padding:9px 11px;border:1px solid #d8e1ee;border-radius:9px;color:var(--ink);background:white;font-size:13px}
        input:focus{border-color:#6e9bf8} .primary{padding:0 13px;border:0;border-radius:9px;color:white;background:var(--blue);white-space:nowrap} .primary:hover{background:#174fd1}
        .suggestions{position:relative;margin:7px 0 0;padding:4px;max-height:220px;overflow:auto;list-style:none;border:1px solid #d8e1ee;border-radius:10px;background:white;box-shadow:0 5px 14px #1938580c}
        .suggestion{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border-radius:6px;cursor:pointer}.suggestion[aria-selected=true],.suggestion:hover{background:#edf3ff;color:#174fc5}.suggestion .code{flex-shrink:0}
        .hint{margin:6px 0 0;color:var(--muted);font-size:11px}.status{display:flex;align-items:center;gap:8px;min-height:29px;padding:6px 1px;color:#397459;font-size:12px;overflow-wrap:anywhere}.status[data-error=true]{color:#c13e4c}.status span{flex:1}
        .text-button{border:0;background:transparent;color:var(--blue);padding:3px 2px;white-space:nowrap;font-size:12px}.text-button:hover{text-decoration:underline}
        .filter-row{display:flex;align-items:center;gap:8px;margin-top:2px}.filter-row input{padding:7px 10px;font-size:12px}.visible-count{white-space:nowrap;color:var(--muted);font-size:11px}
        .items{list-style:none;max-height:278px;overflow:auto;overscroll-behavior:contain;margin:9px 0 0;padding:3px 8px;background:white;border:1px solid #e3e9f3;border-radius:11px}
        .item{display:flex;align-items:center;gap:4px;padding:7px 0;border-bottom:1px solid #edf1f7}.item:last-child{border-bottom:0}.stock{display:block;flex:1;min-width:0;padding:3px 4px;border-radius:6px}.stock:hover{color:var(--blue);background:#f3f7ff}.stock[aria-busy=true]{opacity:.5;pointer-events:none}.name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}.code{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11px}
        .actions{display:flex;gap:1px}.action{width:25px;height:28px;padding:0;border:0;border-radius:6px;color:#8695aa;background:transparent;font-size:12px}.action:hover:enabled{color:var(--blue);background:#eef4ff}.remove:hover:enabled{color:#bc3545;background:#fff0f1}.empty{padding:24px 8px;text-align:center;color:var(--muted);font-size:12px}
        .tools{display:flex;align-items:center;gap:13px;margin-top:8px}.tools .text-button:last-child{margin-left:auto}.tools .text-button{font-size:11px} details{margin-top:9px;border-top:1px solid #e1e8f2;padding-top:9px;color:var(--muted);font-size:12px} summary{cursor:pointer;user-select:none}.settings{display:grid;gap:8px;padding-top:10px}.settings label{display:flex;align-items:flex-start;gap:6px;cursor:pointer}.settings input[type=checkbox]{accent-color:var(--blue);margin:3px 0 0}.manual-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.manual-form button{grid-column:1 / -1;padding:7px;border:1px solid #d6e2f6;border-radius:8px;background:#edf3ff;color:#2156bc}
        .footer{margin-top:11px;font-size:10px;color:#8c99ac}.kbd{padding:0 3px;border:1px solid #dce4ef;border-radius:3px;font-size:10px}
        @media(prefers-reduced-motion:no-preference){.primary{transition:background .13s}} @media(max-width:480px){:host{top:12px;right:12px}.items{max-height:230px}}
        :host{--surface:#fff;--panel:#f7f9fd;--line:#dce5f1;--hover:#edf3ff;--good:#397459;--danger:#c13e4c;--shadow:#16325429;--star:#7541b7;--gem:#176b4b;--hk:#895d18}
        :host([data-theme=dark]){color-scheme:dark;--surface:#1c273a;--panel:#152033;--line:#33435b;--hover:#273c60;--ink:#e5edf9;--muted:#a1b2cc;--blue:#8ab5ff;--good:#8bdbb4;--danger:#ff9eaa;--shadow:#0006;--star:#c4b5fd;--gem:#6ee7b7;--hk:#fcd34d}
        @media(prefers-color-scheme:dark){:host([data-theme=system]){color-scheme:dark;--surface:#1c273a;--panel:#152033;--line:#33435b;--hover:#273c60;--ink:#e5edf9;--muted:#a1b2cc;--blue:#8ab5ff;--good:#8bdbb4;--danger:#ff9eaa;--shadow:#0006;--star:#c4b5fd;--gem:#6ee7b7;--hk:#fcd34d}}
        .panel{background:var(--panel);border-color:var(--line);box-shadow:0 12px 38px var(--shadow)}
        input[type=text],input[type=search],select,.items,.suggestions{background:var(--surface);border-color:var(--line);color:var(--ink)}
        input::placeholder{color:var(--muted);opacity:.85}.primary{background:#2463eb}.item,details{border-color:var(--line)}
        .stock:hover,.suggestion[aria-selected=true],.suggestion:hover,.action:hover:enabled{background:var(--hover);color:var(--blue)}
        .status{color:var(--good);min-height:24px}.status[data-error=true]{color:var(--danger)}.remove:hover:enabled{color:var(--danger);background:var(--hover)}
        .footer,.hint,.caption,.empty,.code{color:var(--muted)}.manual-form button{color:var(--blue);background:var(--hover);border-color:var(--line)}
        .filter-row{margin-top:12px;gap:6px}.filter-box{position:relative;flex:1;min-width:0}.filter-box input{padding-right:30px}.clear-filter{position:absolute;right:5px;top:3px;width:25px;height:25px;border:0;border-radius:5px;color:var(--muted);background:transparent}
        .manage{border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--muted);padding:5px 7px;font-size:11px;white-space:nowrap}.manage[aria-pressed=true]{background:var(--hover);color:var(--blue)}
        .actions{display:none}:host([data-managing=true]) .actions{display:flex}.market{display:inline-block;margin-left:6px;font-size:10px;color:var(--muted)}
        .more{list-style:none;text-align:center;padding:8px}.more button{width:100%;border:0;padding:7px;border-radius:6px;background:var(--hover);color:var(--blue);font-size:12px}
        .settings .select-label{align-items:center;justify-content:space-between}.settings select{max-width:180px;border:1px solid var(--line);border-radius:7px;padding:5px 8px;font:inherit}
        :host([data-compact=true]) .item{padding:3px 0}:host([data-compact=true]) .name{display:inline;font-size:12px}:host([data-compact=true]) .stock>.code{float:right;margin-left:7px;padding-top:2px}
        :host([data-collapsed=true]){width:166px}:host([data-collapsed=true]) header{padding:8px 10px;gap:5px}:host([data-collapsed=true]) .title{font-size:12px}:host([data-collapsed=true]) .icon{width:25px;height:25px}:host([data-collapsed=true]) .panel{border-radius:24px}
        @media(pointer:coarse){.action{width:32px;height:36px}.suggestion{min-height:42px}}
        .board-row{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--muted)}.board-row select{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:7px;font:inherit}
        .stock-heading{display:flex;align-items:center;gap:6px;min-width:0}.stock-heading .name{min-width:0;flex:0 1 auto}
        .board{flex:0 0 auto;margin:0;padding:0 4px;border:1px solid var(--line);border-radius:4px;font-size:10px;font-weight:400;line-height:1.6;color:var(--blue)}
        .board[data-board=star]{color:var(--star)}.board[data-board=gem]{color:var(--gem)}.board[data-board=hk]{color:var(--hk)}.board[data-board=other]{color:var(--muted)}
        :host([data-compact=true]) .stock{display:flex;align-items:center;gap:7px}:host([data-compact=true]) .stock-heading{flex:1}:host([data-compact=true]) .stock>.code{float:none;flex:0 0 auto;padding:0;margin:0}
    `;

    function createWatchlistPanel() {
        if (!['www.cninfo.com.cn', 'cninfo.com.cn'].includes(window.location.hostname)) return;
        if (document.getElementById('cninfo-watchlist')) return;
        const host = document.createElement('div');
        host.id = 'cninfo-watchlist';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${STYLE}</style>
            <section class="panel" aria-label="我的自选股">
                <header title="拖动调整位置；双击收起或展开">
                    <span class="title">我的自选股</span><span class="count">0</span><span class="spacer"></span>
                    <button class="icon" type="button" data-action="toggle" aria-controls="body" aria-expanded="true" title="收起">−</button>
                </header>
                <div class="body" id="body">
                    <label class="caption" for="search">添加自选股</label>
                    <form class="search-form" role="search">
                        <div class="search-wrap"><input id="search" type="text" maxlength="80" placeholder="输入股票名称或代码" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="false" spellcheck="false"></div>
                        <button class="primary" type="submit">添加</button>
                    </form>
                    <ul class="suggestions" id="suggestions" role="listbox" aria-label="股票搜索结果" hidden></ul>
                    <p class="hint">点击结果添加 · <span class="kbd">↑↓</span> 选择 · <span class="kbd">Enter</span> 确认</p>
                    <div class="status" role="status" aria-live="polite" hidden><span></span><button class="text-button" type="button" data-action="undo" hidden>撤销删除</button></div>
                    <div class="filter-row"><div class="filter-box"><input id="filter" type="text" placeholder="筛选名称、代码或拼音" aria-label="筛选我的自选股" autocomplete="off"><button class="clear-filter" data-action="clear-filter" type="button" title="清空筛选" aria-label="清空筛选" hidden>×</button></div><span class="visible-count"></span><button class="manage" data-action="manage" type="button" aria-pressed="false" title="显示移动和删除按钮">整理</button></div>
                    <label class="board-row" for="board-filter">板块<select id="board-filter" aria-label="按板块筛选自选股">${Object.entries(BOARD_FILTERS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
                    <ul class="items" aria-label="自选股列表"></ul>
                    <div class="tools"><button class="text-button" type="button" data-action="export">导出备份</button><button class="text-button" type="button" data-action="import">合并导入</button><button class="text-button" type="button" data-action="reset">复位面板</button></div>
                    <input id="import-file" type="file" accept=".json,application/json" aria-label="选择自选股备份文件" hidden>
                    <details><summary>偏好设置与手动添加</summary><div class="settings">
                        <label><input id="background" type="checkbox">在后台打开 PDF 和股票公告</label>
                        <label><input id="auto-redirect" type="checkbox">进入公告详情页时自动跳转 PDF</label>
                        <label><input id="compact" type="checkbox">紧凑列表，一屏显示更多收藏</label>
                        <label class="select-label" for="theme">外观<select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                        <span class="hint">按住 Alt 点击公告可查看原始详情页。搜索失败时，可先手动保存，稍后再匹配详情。</span>
                    </div><form class="manual-form"><input name="name" type="text" maxlength="80" placeholder="股票名称（必填）" aria-label="手动添加股票名称" required><input name="code" type="text" maxlength="16" placeholder="股票代码（选填）" aria-label="手动添加股票代码"><button type="submit">手动保存自选股</button></form></details>
                    <div class="footer">Alt+W 快速添加 · Esc 收起 · 数据仅存当前浏览器</div>
                </div>
            </section>`;
        document.body.append(host);
        const $ = selector => root.querySelector(selector);
        const searchInput = $('#search');
        const searchForm = $('.search-form');
        const suggestionList = $('#suggestions');
        const items = $('.items');
        const status = $('.status');
        const undoButton = $('[data-action="undo"]');
        const toggleButton = $('[data-action="toggle"]');
        const header = $('header');
        const boardFilter = $('#board-filter');
        const savedBoard = read(STORAGE.board, 'all');
        boardFilter.value = Object.hasOwn(BOARD_FILTERS, savedBoard) ? savedBoard : 'all';
        let results = [];
        let selectedIndex = -1;
        let searchVersion = 0;
        let searchTimer;
        let searchController;
        let messageTimer;
        let composing = false;
        let drag = null;
        let renderedList = [];
        let renderLimit = PAGE_SIZE;
        let lastFilter = '';
        let adding = false;
        let arranging = false;
        const opening = new Set();
        const undoStack = [];

        function showMessage(text, error = false, persistent = false) {
            window.clearTimeout(messageTimer);
            status.querySelector('span').textContent = text;
            status.dataset.error = String(error);
            status.hidden = !text && undoButton.hidden;
            if (!persistent) messageTimer = window.setTimeout(() => {
                status.querySelector('span').textContent = '';
                status.hidden = undoButton.hidden;
            }, 5000);
        }

        function write(key, value) {
            try { GM_setValue(key, value); return true; }
            catch { showMessage('保存失败，请检查油猴扩展的存储权限', true, true); return false; }
        }

        async function commit(edit, focus) {
            try {
                const value = await updateWatchlist(edit);
                renderItems(focus);
                return { ok: true, value };
            } catch (error) {
                showMessage(`保存失败：${error.message || '请检查扩展存储权限'}`, true, true);
                return { ok: false };
            }
        }

        function cancelSearch() {
            searchVersion++;
            window.clearTimeout(searchTimer);
            searchController?.abort();
            searchController = null;
            searchInput.removeAttribute('aria-busy');
            if (status.querySelector('span').textContent === '正在搜索…') showMessage('');
        }

        function hideSuggestions() {
            results = [];
            selectedIndex = -1;
            suggestionList.replaceChildren();
            suggestionList.hidden = true;
            searchInput.setAttribute('aria-expanded', 'false');
            searchInput.removeAttribute('aria-activedescendant');
        }

        function node(tag, className, text) {
            const element = document.createElement(tag);
            element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }

        function updateSelection() {
            [...suggestionList.children].forEach((option, index) => option.setAttribute('aria-selected', String(index === selectedIndex)));
            const current = suggestionList.children[selectedIndex];
            if (current) {
                searchInput.setAttribute('aria-activedescendant', current.id);
                current.scrollIntoView({ block: 'nearest' });
            } else searchInput.removeAttribute('aria-activedescendant');
        }

        function renderSuggestions(found) {
            results = found;
            selectedIndex = -1;
            const list = getWatchlist();
            const stockIndex = createStockIndex();
            list.forEach((item, index) => stockIndex.add(item, index));
            suggestionList.replaceChildren(...found.map((stock, index) => {
                const option = node('li', 'suggestion');
                option.id = `cninfo-suggestion-${index}`;
                option.dataset.index = String(index);
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', 'false');
                const board = classifyBoard(stock);
                const label = board.id === 'other' ? stock.market : board.label;
                option.append(node('span', '', stock.name), node('span', 'code', `${stock.code}${label ? ' · ' + label : ''}${stockIndex.find(stock) >= 0 ? ' · 已添加' : ''}`));
                return option;
            }));
            suggestionList.hidden = !found.length;
            searchInput.setAttribute('aria-expanded', String(!!found.length));
            clampPosition();
        }

        async function runSearch(value, version, addExact = false) {
            searchController = new AbortController();
            searchInput.setAttribute('aria-busy', 'true');
            showMessage('正在搜索…', false, true);
            try {
                const found = await searchStocks(value, searchController.signal);
                if (version !== searchVersion || searchInput.value.trim() !== value) return;
                const exact = found.filter(stock => stock.code.toLowerCase() === value.toLowerCase() || stock.name === value);
                if (addExact && exact.length === 1) { await addStock(exact[0]); return; }
                renderSuggestions(found);
                showMessage(found.length ? `找到 ${found.length} 个结果，选择后添加` : '没有找到匹配公司，试试完整代码或手动添加');
            } catch (error) {
                if (version !== searchVersion || error.name === 'AbortError') return;
                hideSuggestions();
                showMessage(error.message || '搜索失败，请检查网络后重试', true, true);
            } finally {
                if (version === searchVersion) searchInput.removeAttribute('aria-busy');
            }
        }

        function queueSearch() {
            cancelSearch();
            hideSuggestions();
            const value = searchInput.value.trim();
            if (composing || !value) { showMessage(''); return; }
            const version = searchVersion;
            searchTimer = window.setTimeout(() => runSearch(value, version), 250);
        }

        async function addStock(raw, manual = false) {
            if (adding) return;
            const stock = normalizeStock(raw);
            if (!stock) { showMessage('请输入名称和有效代码（字母、数字、点或短横线）', true); return; }
            adding = true;
            searchForm.querySelector('button').disabled = true;
            try {
                const saved = await commit(list => {
                    const merged = mergeWatchlist(list, [stock]);
                    return { list: merged.added || merged.updated ? merged.list : null, value: merged };
                });
                if (!saved.ok) return;
                if (!saved.value.added && !saved.value.updated) { showMessage(`${stock.name} 已在自选中`); return; }
                cancelSearch();
                hideSuggestions();
                searchForm.reset();
                if (manual) $('.manual-form').reset();
                if ($('#filter').value || !matchesBoard(stock, boardFilter.value)) {
                    $('#filter').value = '';
                    if (!matchesBoard(stock, boardFilter.value)) { boardFilter.value = 'all'; write(STORAGE.board, 'all'); }
                    renderItems();
                }
                showMessage(`${saved.value.added ? '已添加' : '已补全'} ${stock.name}${manual ? '，打开时将自动匹配详情' : ''}`);
                searchInput.focus();
            } finally {
                adding = false;
                searchForm.querySelector('button').disabled = false;
            }
        }

        searchInput.addEventListener('compositionstart', () => { composing = true; cancelSearch(); hideSuggestions(); });
        searchInput.addEventListener('compositionend', () => { composing = false; queueSearch(); });
        searchInput.addEventListener('input', queueSearch);
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim() && suggestionList.hidden && !adding && !searchInput.hasAttribute('aria-busy')) queueSearch();
        });
        searchInput.addEventListener('keydown', event => {
            if (event.isComposing || composing || event.keyCode === 229) return;
            if (event.key === 'Escape' && (!suggestionList.hidden || searchInput.hasAttribute('aria-busy'))) {
                event.preventDefault(); event.stopPropagation(); cancelSearch(); hideSuggestions(); showMessage('');
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
                event.preventDefault();
                selectedIndex = event.key === 'ArrowDown' ? (selectedIndex + 1) % results.length : (selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1);
                updateSelection();
            }
        });
        searchForm.addEventListener('submit', event => {
            event.preventDefault();
            if (composing) return;
            const exact = results.filter(item => item.code.toLowerCase() === searchInput.value.trim().toLowerCase() || item.name === searchInput.value.trim());
            const stock = selectedIndex >= 0 ? results[selectedIndex] : (exact.length === 1 ? exact[0] : null);
            if (stock) addStock(stock);
            else if (results.length) showMessage('请选择一个搜索结果，避免添加错误的股票', true);
            else {
                cancelSearch();
                const value = searchInput.value.trim();
                if (!value) { showMessage('先输入股票名称或代码', true); searchInput.focus(); }
                else runSearch(value, searchVersion, true);
            }
        });
        // 鼠标选择不转移焦点；触摸仍允许原生滚动候选列表。
        suggestionList.addEventListener('pointerdown', event => { if (event.pointerType !== 'touch') event.preventDefault(); });
        suggestionList.addEventListener('click', event => {
            const option = event.target.closest('[data-index]');
            if (option) addStock(results[Number(option.dataset.index)]);
        });
        document.addEventListener('pointerdown', event => {
            if (!event.composedPath().includes(host)) { cancelSearch(); hideSuggestions(); }
        }, true);
        $('.manual-form').addEventListener('submit', event => {
            event.preventDefault();
            addStock({ name: event.currentTarget.elements.name.value, code: event.currentTarget.elements.code.value, orgId: '' }, true);
        });

        function rowAction(action, label, text, disabled = false) {
            const button = node('button', `action ${action === 'remove' ? 'remove' : ''}`, text);
            button.type = 'button';
            button.dataset.action = action;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.disabled = disabled;
            return button;
        }

        function renderItems(focus) {
            let list;
            try { list = getWatchlist(); }
            catch (error) {
                renderedList = [];
                items.replaceChildren(node('li', 'empty', '暂时无法读取收藏，请检查扩展存储'));
                $('.count').textContent = '?';
                showMessage(error.message, true, true);
                return;
            }
            const active = root.activeElement;
            const focusedRow = active?.closest('.item');
            const restore = focus || (focusedRow ? { stock: renderedList[Number(focusedRow.dataset.index)], action: active.dataset.action } : null);
            const filter = $('#filter').value.trim().toLowerCase();
            const filterKey = `${boardFilter.value}:${filter}`;
            if (filterKey !== lastFilter) { renderLimit = PAGE_SIZE; lastFilter = filterKey; }
            const counts = { all: list.length, main: 0 };
            renderedList = list.filter(item => {
                const board = classifyBoard(item);
                counts[board.id] = (counts[board.id] || 0) + 1;
                if (board.id === 'sh_main' || board.id === 'sz_main') counts.main++;
                return matchesBoard(item, boardFilter.value) && `${item.name}\n${item.code}\n${item.pinyin || ''}\n${board.label}`.toLowerCase().includes(filter);
            });
            for (const option of boardFilter.options) option.textContent = `${BOARD_FILTERS[option.value]} · ${counts[option.value] || 0}`;
            const focusIndex = restore?.stock ? renderedList.findIndex(item => sameStock(item, restore.stock)) : restore?.index;
            if (focusIndex >= renderLimit) renderLimit = Math.ceil((focusIndex + 1) / PAGE_SIZE) * PAGE_SIZE;
            $('.count').textContent = String(list.length);
            $('.visible-count').textContent = filter || boardFilter.value !== 'all' ? `${renderedList.length} / ${list.length}` : `${list.length} 只`;
            $('[data-action="clear-filter"]').hidden = !filter && boardFilter.value === 'all';
            const scrollTop = items.scrollTop;
            items.replaceChildren(...renderedList.slice(0, renderLimit).map((stock, index) => {
                const row = node('li', 'item');
                row.dataset.index = String(index);
                const link = node('a', 'stock');
                link.href = stock.orgId && stock.code ? buildStockDetailUrl(stock) : '#';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.title = `查看 ${stock.name} 最新公告${stock.orgId ? '' : '（首次打开需要联网匹配）'}`;
                if (opening.has(stockKey(stock))) link.setAttribute('aria-busy', 'true');
                const name = node('span', 'name', stock.name);
                name.title = stock.name;
                const heading = node('span', 'stock-heading');
                const board = classifyBoard(stock);
                const badge = node('span', 'market board', board.id === 'other' ? (stock.market || '未识别') : board.label);
                badge.dataset.board = board.id;
                badge.title = board.id === 'other' ? '未归入沪深主板、科创板、创业板或港股' : `${board.label} · 按证券代码和市场信息识别`;
                heading.append(name, badge);
                link.append(heading, node('span', 'code', stock.code || '名称收藏 · 待匹配代码'));
                const actions = node('div', 'actions');
                actions.append(rowAction('up', `上移 ${stock.name}`, '↑', index === 0), rowAction('down', `下移 ${stock.name}`, '↓', index === renderedList.length - 1), rowAction('remove', `删除 ${stock.name}`, '×'));
                row.append(link, actions);
                return row;
            }));
            if (!renderedList.length) items.append(node('li', 'empty', filter || boardFilter.value !== 'all' ? '没有匹配项，清空筛选后查看全部' : '还没有自选股，从上方搜索添加吧'));
            if (renderedList.length > renderLimit) {
                const more = node('li', 'more');
                const button = node('button', '', `再显示 ${Math.min(PAGE_SIZE, renderedList.length - renderLimit)} 只 · 剩余 ${renderedList.length - renderLimit} 只`);
                button.type = 'button'; button.dataset.action = 'more';
                more.append(button); items.append(more);
            }
            items.scrollTop = scrollTop;
            if (restore && focusIndex >= 0) {
                const row = items.querySelector(`[data-index="${focusIndex}"]`);
                const button = restore.action ? row?.querySelector(`[data-action="${restore.action}"]`) : null;
                (button && !button.disabled ? button : row?.querySelector('.stock'))?.focus({ preventScroll: true });
            }
            clampPosition();
        }

        async function openStock(stock, link, active) {
            const key = stockKey(stock);
            if (opening.has(key)) return;
            opening.add(key);
            link.setAttribute('aria-busy', 'true');
            try {
                let resolved = stock;
                if (!stock.orgId || !stock.code) {
                    resolved = findExactStock(await searchStocks(stock.code || stock.name), stock);
                    if (!resolved) throw new Error('未找到唯一匹配，请用完整代码重新搜索并添加');
                    // 联网期间其他标签可能修改列表，因此在写入时重新读取。
                    await commit(list => {
                        const index = list.findIndex(item => sameStock(item, stock));
                        if (index < 0) return { list: null };
                        const other = list.findIndex((item, i) => i !== index && sameStock(item, resolved));
                        if (other >= 0) list.splice(index, 1);
                        else list[index] = resolved;
                        return { list };
                    });
                }
                openTab(buildStockDetailUrl(resolved), active);
            } catch (error) { showMessage(error.message || '打开失败，请稍后重试', true, true); }
            finally {
                opening.delete(key);
                link.removeAttribute('aria-busy');
                items.querySelectorAll('.stock[aria-busy]').forEach(current => {
                    const item = renderedList[Number(current.closest('.item').dataset.index)];
                    if (item && !opening.has(stockKey(item))) current.removeAttribute('aria-busy');
                });
            }
        }

        async function handleItemClick(event) {
            if (event.type === 'auxclick' && event.button !== 1) return;
            const button = event.target.closest('button');
            if (event.type === 'click' && button?.dataset.action === 'more') {
                const first = renderLimit;
                renderLimit += PAGE_SIZE;
                renderItems({ index: first });
                return;
            }
            const row = event.target.closest('.item');
            if (!row) return;
            const index = Number(row.dataset.index);
            const stock = renderedList[index];
            if (!stock) return;
            const link = event.target.closest('.stock');
            if (link) { event.preventDefault(); openStock(stock, link, shouldOpenActive(event)); return; }
            if (event.type === 'auxclick') return;
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'remove') {
                const saved = await commit(list => {
                    const current = list.findIndex(item => sameStock(item, stock));
                    if (current < 0) return { list: null, value: null };
                    const [removed] = list.splice(current, 1);
                    return { list, value: { stock: removed, index: current } };
                });
                if (saved.ok && saved.value) {
                    undoStack.push(saved.value);
                    if (undoStack.length > 20) undoStack.shift();
                    undoButton.hidden = false;
                    showMessage(`已删除 ${stock.name}，可撤销`);
                    const nextRow = items.querySelector(`[data-index="${Math.min(index, renderedList.length - 1)}"]`);
                    (nextRow?.querySelector('[data-action="remove"]') || undoButton).focus();
                }
            } else if (action === 'up' || action === 'down') {
                const target = index + (action === 'up' ? -1 : 1);
                const neighbor = renderedList[target];
                if (!neighbor) return;
                await commit(list => {
                    const current = list.findIndex(item => sameStock(item, stock));
                    const other = list.findIndex(item => sameStock(item, neighbor));
                    if (current < 0 || other < 0) return { list: null };
                    [list[current], list[other]] = [list[other], list[current]];
                    return { list };
                }, { stock, action });
            }
        }
        items.addEventListener('click', handleItemClick);
        items.addEventListener('auxclick', handleItemClick);
        $('#filter').addEventListener('input', () => renderItems());
        boardFilter.addEventListener('change', () => { write(STORAGE.board, boardFilter.value); renderItems(); });
        function clearFilter() {
            $('#filter').value = '';
            if (boardFilter.value !== 'all') { boardFilter.value = 'all'; write(STORAGE.board, 'all'); }
            renderItems();
            $('#filter').focus();
        }
        $('[data-action="clear-filter"]').addEventListener('click', clearFilter);
        $('#filter').addEventListener('keydown', event => {
            if (event.key === 'Escape' && (event.currentTarget.value || boardFilter.value !== 'all')) { event.preventDefault(); event.stopPropagation(); clearFilter(); }
        });
        $('[data-action="manage"]').addEventListener('click', event => {
            arranging = !arranging;
            host.dataset.managing = String(arranging);
            event.currentTarget.textContent = arranging ? '完成' : '整理';
            event.currentTarget.setAttribute('aria-pressed', String(arranging));
            if (arranging) { cancelSearch(); hideSuggestions(); showMessage('使用 ↑↓ 调整顺序，× 删除后可撤销'); }
        });
        undoButton.addEventListener('click', async () => {
            if (undoButton.disabled) return;
            const last = undoStack[undoStack.length - 1];
            if (!last) return;
            undoButton.disabled = true;
            const saved = await commit(list => {
                if (list.some(item => sameStock(item, last.stock))) return { list: null };
                list.splice(Math.min(last.index, list.length), 0, last.stock);
                return { list };
            });
            undoButton.disabled = false;
            if (!saved.ok) return;
            const entry = undoStack.indexOf(last);
            if (entry >= 0) undoStack.splice(entry, 1);
            undoButton.hidden = !undoStack.length;
            showMessage(`已恢复 ${last.stock.name}`);
            if ($('#filter').value || !matchesBoard(last.stock, boardFilter.value)) {
                $('#filter').value = '';
                if (!matchesBoard(last.stock, boardFilter.value)) { boardFilter.value = 'all'; write(STORAGE.board, 'all'); }
                renderItems();
            }
        });

        $('[data-action="export"]').addEventListener('click', () => {
            try {
                // 导出原始存储，即使个别条目损坏也不静默丢弃，便于手动修复。
                const data = { app: 'cninfo-pdf-direct', version: 1, exportedAt: new Date().toISOString(), watchlist: GM_getValue(STORAGE.watchlist, []) };
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
                const link = node('a', '');
                link.href = url;
                link.download = `cninfo-watchlist-${new Date().toISOString().slice(0, 10)}.json`;
                root.append(link);
                link.click();
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 10000);
                showMessage('已发起备份下载，请在浏览器下载列表中确认');
            } catch { showMessage('导出失败，请检查浏览器下载和扩展存储权限', true, true); }
        });
        $('[data-action="import"]').addEventListener('click', () => $('#import-file').click());
        $('#import-file').addEventListener('change', async event => {
            const input = event.currentTarget;
            const file = input.files[0];
            if (!file) return;
            const importButton = $('[data-action="import"]');
            importButton.disabled = true;
            try {
                if (file.size > 2 * 1024 * 1024) throw new Error('文件不能超过 2 MB');
                const imported = parseImport(await file.text());
                const saved = await commit(list => {
                    const merged = mergeWatchlist(list, imported);
                    return { list: merged.added || merged.updated ? merged.list : null, value: merged };
                });
                if (saved.ok) {
                    const merged = saved.value;
                    showMessage(`导入完成：新增 ${merged.added} 只，补全 ${merged.updated} 只，已有条目自动跳过`);
                }
            } catch (error) { showMessage(error instanceof SyntaxError ? 'JSON 格式无效，未修改现有自选股' : error.message, true, true); }
            finally { input.value = ''; importButton.disabled = false; }
        });

        function clampPosition() {
            const rect = host.getBoundingClientRect();
            const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - rect.width - 8));
            const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - Math.min(rect.height, 110) - 8));
            if (host.style.left !== `${left}px`) host.style.left = `${left}px`;
            if (host.style.top !== `${top}px`) host.style.top = `${top}px`;
            host.style.right = 'auto';
            const height = `${Math.max(60, window.innerHeight - top - header.offsetHeight - 16)}px`;
            if (host.style.getPropertyValue('--body-height') !== height) host.style.setProperty('--body-height', height);
        }

        function persistPosition() {
            const rect = host.getBoundingClientRect();
            write(STORAGE.position, { left: rect.left, top: rect.top, collapsed: $('#body').hidden });
        }

        function setCollapsed(collapsed, persist = true) {
            const before = host.getBoundingClientRect();
            const anchoredRight = before.left + before.width / 2 > window.innerWidth / 2;
            $('#body').hidden = collapsed;
            host.dataset.collapsed = String(collapsed);
            toggleButton.textContent = collapsed ? '+' : '−';
            toggleButton.title = collapsed ? '展开自选股' : '收起自选股';
            toggleButton.setAttribute('aria-label', toggleButton.title);
            toggleButton.setAttribute('aria-expanded', String(!collapsed));
            if (collapsed) { cancelSearch(); hideSuggestions(); }
            if (persist) {
                if (anchoredRight) host.style.left = `${before.right - host.getBoundingClientRect().width}px`;
                write(STORAGE.collapsed, collapsed);
            }
            clampPosition();
            if (persist) persistPosition();
        }

        toggleButton.addEventListener('click', () => setCollapsed(!$('#body').hidden));
        header.addEventListener('dblclick', event => { if (!event.target.closest('button')) setCollapsed(!$('#body').hidden); });
        header.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.isPrimary === false || event.target.closest('button')) return;
            const rect = host.getBoundingClientRect();
            drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
            header.classList.add('dragging');
            header.setPointerCapture(event.pointerId);
        });
        let dragFrame = 0;
        function applyDrag() {
            dragFrame = 0;
            if (!drag || drag.left === undefined) return;
            host.style.left = `${drag.left}px`;
            host.style.top = `${drag.top}px`;
            clampPosition();
        }
        header.addEventListener('pointermove', event => {
            if (!drag || drag.id !== event.pointerId) return;
            drag.left = event.clientX - drag.x;
            drag.top = event.clientY - drag.y;
            if (!dragFrame) dragFrame = window.requestAnimationFrame(applyDrag);
        });
        function finishDrag(event) {
            if (!drag || drag.id !== event.pointerId) return;
            if (dragFrame) window.cancelAnimationFrame(dragFrame);
            applyDrag();
            drag = null;
            header.classList.remove('dragging');
            if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
            persistPosition();
        }
        header.addEventListener('pointerup', finishDrag);
        header.addEventListener('pointercancel', finishDrag);
        header.addEventListener('lostpointercapture', finishDrag);
        let resizeTimer;
        window.addEventListener('resize', () => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(clampPosition, 100);
        });
        if (typeof ResizeObserver === 'function') new ResizeObserver(clampPosition).observe($('.panel'));

        function resetPanel() {
            setCollapsed(false);
            host.style.left = `${Math.max(8, window.innerWidth - host.offsetWidth - 20)}px`;
            host.style.top = window.innerWidth <= 480 ? '12px' : '76px';
            clampPosition();
            persistPosition();
            showMessage('面板已复位');
        }
        $('[data-action="reset"]').addEventListener('click', resetPanel);
        function focusSearch() { setCollapsed(false); searchInput.focus(); searchInput.select(); }
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('复位自选股面板', resetPanel);
            GM_registerMenuCommand('搜索添加自选股（Alt+W）', focusSearch);
        }
        document.addEventListener('keydown', event => {
            if (!event.defaultPrevented && !event.repeat && !event.isComposing && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyW') {
                event.preventDefault(); focusSearch();
            }
        });
        root.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !event.isComposing && !composing && !event.defaultPrevented && event.target.tagName !== 'SELECT') {
                event.preventDefault(); setCollapsed(true); toggleButton.focus();
            }
        });
        root.addEventListener('focusin', event => {
            if (!searchForm.contains(event.target) && !suggestionList.contains(event.target)) { cancelSearch(); hideSuggestions(); }
        });
        function applySettings() {
            const settings = getSettings();
            $('#background').checked = settings.background;
            $('#auto-redirect').checked = settings.autoRedirect;
            $('#compact').checked = settings.compact;
            $('#theme').value = settings.theme;
            host.dataset.theme = settings.theme;
            host.dataset.compact = String(settings.compact);
        }
        applySettings();
        const settingFields = { '#background': 'background', '#auto-redirect': 'autoRedirect', '#compact': 'compact', '#theme': 'theme' };
        for (const [selector, key] of Object.entries(settingFields)) {
            $(selector).addEventListener('change', event => {
                const saved = getSettings();
                const value = key === 'theme' ? event.target.value : event.target.checked;
                if (write(STORAGE.settings, { ...saved, [key]: value })) showMessage('偏好设置已保存');
                applySettings();
            });
        }
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(STORAGE.watchlist, (_key, _old, _value, remote) => {
                if (remote) { invalidateWatchlist(); renderItems(); }
            });
            GM_addValueChangeListener(STORAGE.settings, (_key, _old, _value, remote) => {
                if (!remote) return;
                applySettings();
            });
        }
        setCollapsed(read(STORAGE.collapsed, false) === true, false);
        const position = read(STORAGE.position, null);
        if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
            host.style.left = `${position.left}px`;
            host.style.top = `${position.top}px`;
            host.style.right = 'auto';
        }
        renderItems();
    }

    function main() {
        if (window.self !== window.top) return;
        document.addEventListener('click', handlePdfClick, true);
        document.addEventListener('auxclick', handlePdfClick, true);
        const url = new URL(window.location.href);
        const pdfUrl = buildPdfUrl(url.href);
        if (pdfUrl && getSettings().autoRedirect && url.searchParams.get('cninfoOriginal') !== '1') {
            // 替换当前详情标签，避免原版额外留下一个详情页。
            window.location.replace(pdfUrl);
            return;
        }
        createWatchlistPanel();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
    else main();
})();
