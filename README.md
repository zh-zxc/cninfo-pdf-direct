# 巨潮资讯增强脚本

这是一个适用于巨潮资讯网的 Tampermonkey 用户脚本，提供公告 PDF 直达、本地自选股和公司联想搜索功能。

## 功能

### 公告 PDF 直链

- 在公告列表中点击公告时，直接打开 PDF；
- 直接打开公告详情页时，自动跳转到 PDF；
- 支持 A 股和港股公告；
- 自动处理港股公告时间包含时分的情况。

脚本会根据公告链接中的 `announcementId` 和 `announcementTime` 生成：

```text
https://static.cninfo.com.cn/finalpage/日期/公告编号.PDF
```

### 本地自选股

在 `www.cninfo.com.cn` 页面右上角显示“我的自选股”面板：

- 输入公司名称时显示巨潮联想结果；
- 支持 A 股、港股等市场；
- 点击联想结果自动填入股票代码和名称；
- 股票代码可以手动填写，也可以留空；
- 点击自选股直接打开公司详情页的数据标签和最新公告位置；
- 支持按名称或代码筛选；
- 支持删除自选股；
- 标题栏可拖动，位置会自动保存；
- 数据仅保存在当前浏览器，不需要巨潮账号。

详情页地址格式为：

```text
/new/disclosure/stock?tabName=data&stockCode=股票代码&orgId=组织机构ID#latestAnnouncement
```

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`cninfo-pdf-direct.user.js`](./cninfo-pdf-direct.user.js)。
3. 点击 Tampermonkey 提供的安装按钮。
4. 打开或刷新巨潮资讯网即可使用。

脚本配置了自动更新地址。后续发布新版本后，Tampermonkey 可以自动检查更新。

## 使用自选股

1. 打开 `www.cninfo.com.cn`。
2. 在“我的自选股”面板的名称框输入公司名称或代码。
3. 从下拉结果中选择正确的公司。
4. 点击“添加”。
5. 点击列表中的公司名称或代码进入详情页。

如果只记得公司名称，也可以直接添加；没有代码的条目会在点击时再次通过巨潮公开接口查询。

## 数据与隐私

- 自选股和面板位置使用 Tampermonkey 的本地存储；
- 脚本不会保存账号密码，也不会上传自选股列表；
- 联想搜索和补全公司信息时，会请求巨潮资讯的公开查询接口；
- 清理浏览器或 Tampermonkey 的站点数据可能会删除本地自选股。

## 开发检查

修改脚本后可以运行：

```bash
node --check cninfo-pdf-direct.user.js
git diff --check
```

## 发布

版本号位于用户脚本头部的 `@version` 字段。发布时同时推送主分支和版本标签，例如：

```bash
git push origin main v4.4.0
```
