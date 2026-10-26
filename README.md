# 巨潮 PDF 直链与自选股 · v5.2.0

基于原来的 v4.6.0 与上一轮 v5.0.0 优化，保留公告 PDF、自选搜索、手动添加、详情打开、移动排序、撤销、导入导出、面板记忆和跨标签同步。本轮增加板块识别与筛选，并重构数据处理和交互。

## 安装与回退

1. 在油猴 Tampermonkey 管理面板中，编辑原来的“巨潮资讯 PDF 直链打开 (支持港A股)”。
2. 用 `cninfo-pdf-direct.user.js` 的全部内容替换并保存，再刷新巨潮页面。**编辑原脚本即可沿用原自选股；避免同时启用两个副本。**
3. 若想回退，恢复 `previous-v5.0.0.txt`；最初的脚本保存在 `original-v4.6.0.txt`。回退代码不会回滚收藏变更。

名称、namespace 与原有自选股存储键保持兼容。首次修改收藏前仍会保留一次升级前数据，键为 `cninfo-pdf-direct-watchlist-backup-v4`。本地版使用 `@updateURL none`，防止远程更新覆盖本次改动。

## 板块标签和筛选

每只收藏旁显示板块标签，搜索候选也显示所属板块。已有收藏自动识别，不必重新添加。标签即时计算，不向旧收藏写入固定板块值。

| 标签 | 主要识别规则与示例 |
| --- | --- |
| 沪市主板 | 六位代码 `600`、`601`、`603`、`605` 开头，例如 `600519` |
| 深市主板 | 六位代码 `000`—`004` 开头，包含 `002` 原中小板，例如 `000001` |
| 科创板 | `688` 股票、`689` 存托凭证，例如 `688981` |
| 创业板 | 六位代码 `30` 开头，常见 `300`、`301`，例如 `300750` |
| 港股 | 优先使用巨潮的市场字段；缺少字段时结合常见香港股票代码区间，保留 `00700` 等前导零 |
| 其他/未识别 | 明确的基金、债券、指数等非股票类别，以及尚未覆盖的代码 |

“板块”下拉框可选择五类板块或“全部主板”，并显示各类收藏总数。板块条件可与名称、代码、拼音关键词叠加；右侧数量显示当前匹配数/总数。点击筛选框右边的 × 可清除全部筛选。

A/H 两地上市公司可能共用公司 ID：实测 `688981` 的 orgId 为 `gshk0000981`，脚本仍按 A 股代码识别为科创板。不会仅凭公司 ID 把它误分到港股。五位代码并不全是股票，基金、权证等区间不会一律归为港股。分类用于整理收藏，不校验证券是否仍在上市，也不细分香港主板与 GEM。

## 日常操作

- **搜索添加**：输入名称或代码，点击候选，或用 ↑↓ 选中后回车。完整名称/代码首次回车即可搜索并添加唯一精确匹配；有歧义时保留候选让你选择。输入法组词期间暂停搜索，旧响应不会覆盖新结果。
- **整理收藏**：点击“整理”显示 ↑↓ 和 ×；完成后隐藏按钮，减少误触。筛选时只交换相邻可见项。删除支持撤销最近 20 次，记录保留到页面刷新或关闭。
- **快速操作**：`Alt+W` 展开并聚焦搜索；`Esc` 优先关闭候选或清除筛选，再收起面板。标题栏可拖动，双击收起/展开。
- **面板和外观**：收起为 166px 迷你条，保持靠边位置；记住位置、收起状态、主题、密度和板块筛选。提供浅色、深色、跟随系统以及紧凑列表。油猴菜单和面板均有复位入口。
- **PDF**：普通点击前台打开，Ctrl/Cmd 或中键后台打开，Shift 优先前台，Alt 点击原始公告详情。直接进入详情页默认在当前标签替换为 PDF，可在偏好设置关闭。
- **手动添加**：展开“偏好设置与手动添加”，可先保存名称与代码；打开时再尝试联网匹配详情。
- **备份**：导出原始 JSON；导入时合并并跳过重复项、补全缺失资料，不替换整份收藏。单文件不超过 2 MB，新增收藏通常限制为 2000 条；超过上限的旧列表仍可查看、整理和删除。

导出位置遵循浏览器下载设置。卸载脚本或清空扩展数据前，请先导出备份。若数据含损坏条目，修改操作会暂停并提示，原始导出仍可用于修复，避免静默丢失内容。

## 性能与可靠性

- 用索引替代逐条重复遍历，并缓存已规范化的收藏列表。
- 初次显示 60 条，按需“再显示”；筛选和板块统计仍覆盖全部收藏。
- 同一页面的修改排队执行；浏览器支持 Web Locks 时，同源新版标签共享写入锁，锁内重新读取数据。
- 写入失败不会显示成功；读取失败不会按空收藏覆盖。异步打开按股票身份去重，远端刷新保留当前行键盘焦点。
- 搜索有 250ms 防抖、60 秒缓存和 10 秒超时。触摸候选可以正常滚动；拖动按帧合并更新。
- Shadow DOM 隔离网页样式，接口/导入名称以文本渲染，无额外运行依赖。

本机以同样的 2000 条数据、21 次运行的中位数比较 v5.0 与本轮去重函数：**13.125 ms → 0.749 ms，约 17.5 倍**。这只衡量去重环节，不表示整个网页提速相同倍数，结果见 `tests/benchmark.json`。

Web Locks 只协调支持该功能的同源新版本标签；HTTP/HTTPS、其他来源或旧脚本副本不共享该锁，跨来源同时写入仍有最后写入覆盖的可能。PDF 地址沿用原来的日期/公告编号规则，个别无 PDF 或失效公告仍可 Alt 点击查看原详情。

## 预览与验证

双击 `preview.html` 可运行离线交互检查并试用面板。演示支持搜索“贵州茅台、腾讯控股、中芯国际、宁德时代、平安银行”及其代码/拼音，使用隔离的模拟数据，刷新后重置。

本轮完成 **37 项核心检查、30 项真实浏览器交互检查**；桌面、390px 窄窗口、深色和迷你状态分别验证并截图。还在真实巨潮页面完成五类证券的搜索、添加、分类和链接检查，并点击实际公告，读取到 `%PDF-` 文件头（HTTP 206）。线上检查中的油猴存储/开标签接口使用测试替身，尚未验证安装到你实际油猴配置后的权限行为。

主要证据：`tests/core-results.json`、`tests/browser-1180-light.json`、`tests/browser-390-light.json`、`tests/live-results.json`；截图为 `preview-1180-light.png`、`preview-1180-dark.png`、`preview-1180-collapsed.png`、`preview-390-light.png` 和 `preview-live.png`。

核心检查和基准需要 Node.js 18+；浏览器检查需要 Node.js 22+ 及 Edge/Chromium，无需 npm 安装。PowerShell 命令：

```powershell
Set-Location -LiteralPath 'D:\2\codex\cninfo-pdf-direct'
node .\tests\check.cjs
node .\tests\browser-check.cjs
node .\tests\browser-check.cjs 390 844
node .\tests\browser-check.cjs 1180 920 dark
node .\tests\browser-check.cjs 1180 920 collapsed
node .\tests\benchmark.cjs
# 下面这一项访问巨潮公开页面和接口
node .\tests\live-check.cjs
```

本机使用现有 VS Code 内置 Node v24.21.0。没有 PATH 中的 Node 时，可在本机使用以下替代命令；只临时设置当前进程的运行模式：

```powershell
Set-Location -LiteralPath 'D:\2\codex\cninfo-pdf-direct'
$taskPreviousElectron = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & 'C:\Users\zxc\AppData\Local\Programs\Microsoft VS Code\Code.exe' .\tests\check.cjs | Out-String
    if ($LASTEXITCODE -ne 0) { throw '检查失败' }
} finally {
    if ($null -eq $taskPreviousElectron) {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
        $env:ELECTRON_RUN_AS_NODE = $taskPreviousElectron
    }
}
```

## 规则与 API 依据

- [上交所股票及存托凭证](https://www.sse.com.cn/assortment/stock/)、[上交所市场资料（含 688/689 编码）](https://www.sse.com.cn/aboutus/publication/factbook/documents/c/10170562/files/da4f403a0b7443fa9b2ba2e002d38f10.pdf)。
- [深交所证券代码区间表（2024 年 4 月）](https://www.szse.cn/marketServices/technicalservice/doc/P020240510623040090566.pdf)、[深交所技术文档更新目录](https://www.szse.cn/marketServices/technicalservice/doc/)。
- [港交所证券代号编配计划](https://www.hkex.com.hk/Products/Securities/Stock-Code-Allocation-Plan?sc_lang=zh-HK)。
- [Tampermonkey 标签页](https://www.tampermonkey.net/documentation.php?q=GM_openInTab)、[存储与监听](https://www.tampermonkey.net/documentation.php?q=GM_values)、[菜单](https://www.tampermonkey.net/documentation.php?q=GM_registerMenuCommand)。
- [Web Locks 的同源协调范围](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)、[requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。
