# 麦田 · mdldm-maitian

一个人做自媒体的发布中控：一条成片，分批发到 B站、抖音、小红书、视频号、YouTube、X（外加可选的自有课程站），
发完自动取链接、每天采流量和粉丝，飞书群里推卡片，再给你一个能在手机上看的数据大屏。

> 作者在用它发「我看谁不学 Grok Bot」等系列视频。它跑在一台常开的 Mac 上，用你自己登录好的浏览器操作各平台，**不存任何平台密码**。

## 它做什么

- **播种（发布）**：读 NAS 上的一期发布工程（成片、封面、各平台文案、定时），按批次在专用 Chrome 里填好各平台上传页。
  - X、YouTube、自有站点：回读文案和定时一致后自动提交，只点一次。
  - B站、抖音、小红书、视频号：**填好就停**，等你自己点「发布 / 定时发布」，守护进程每 20 分钟提醒。
  - 防重：库里已经到位的平台不再跑；X 定时列表、YouTube Studio、站点后台已有同名的不再传。
- **长势（流量和粉丝）**：每天上午采一次各期在各平台的播放和互动、各平台粉丝数；新一期头三天每 6 小时采一次。
- **收成（转化，可选）**：接上自有站点后，看注册、会员、订单、收入从哪个渠道、哪一期来。
- **粮仓（档案）**：每期的封面、文案快照、各平台链接、过程日志。
- **飞书通知**：开跑、每个平台到位、异常、等你点发布、定时被平台改掉、每日日报，都是带颜色的卡片。

## 架构

```
            ┌────────────── Mac（常开）──────────────┐
NAS 发布工程 │  hub.mjs 守护进程 ──── 专用 Chrome（CDP 9333）── 各平台创作者后台
publish.json ─▶│     │  ▲                 ▲                       │
成片/封面     │     │  │ 平台适配器（obsidian-x-publisher/lib）   │
            │     ▼  │                                          │
            │  SQLite（data/hub.db） ── web.mjs（麦田网页 :8787）── 手机/电脑（可选 Cloudflare 隧道）
            │     │                                              │
            │     └── feishu.mjs ──▶ 飞书群机器人（卡片通知）       │
            └───────────────────────────────────────────────┘
```

- 平台填写逻辑在姊妹仓库 [obsidian-x-publisher](https://github.com/CzzzzzzJ/obsidian-x-publisher)（Chrome 插件）里，麦田直接加载它的 `lib/`，适配器只维护一份。`src/chrome-shim.mjs` 在 Node 里模拟插件需要的 `chrome.tabs` / `chrome.debugger`。
- 发布工程 `publish.json` 由插件仓库的 `tools/make-publish.mjs` 从一份 Markdown 发布素材生成，`tools/validate.mjs` 校验（字数、禁词、封面比例、成片 faststart 等）。

## 安装

需要：macOS、Node.js ≥ 22.5（用到内置 `node:sqlite`）、Google Chrome；可选 NAS（放成片）、飞书群机器人、cloudflared。

```bash
git clone https://github.com/CzzzzzzJ/obsidian-x-publisher.git
git clone https://github.com/CzzzzzzJ/mdldm-maitian.git && cd mdldm-maitian
cp config.example.json config.json      # 填 pluginDir、rootPath、feishuWebhook、web.key……
node src/hub.mjs login                  # 打开专用 Chrome 和各平台页面，逐个扫码 / 登录
node src/hub.mjs doctor                 # 检查各平台登录态和上传页（不上传、不填写）
scripts/install-launchd.sh              # 装成开机自启的守护进程（加 --tunnel 顺带装远程访问）
```

打开 `http://localhost:8787/?key=<web.key>`，之后浏览器会记住口令。

## 命令

```bash
node src/hub.mjs run <工程目录> [--only x,zsz] [--force] [--now]   # 发一期；--now 让站点课程立即上线（默认推迟到定时前 30 分钟）
node src/hub.mjs status [id] [--logs]
node src/hub.mjs sync <id> [--only a,b]     # 取链接，写 发布记录.json，回填发布素材 md 的「已发布」行
node src/hub.mjs mark <id> <平台> <状态> [备注] [--url 链接]   # 手动改状态（平台认不出时用）
node src/hub.mjs adopt <工程目录>            # 登记一期已经发过的（不上传），按标题取链接
node src/hub.mjs metrics [id]               # 采流量并发日报
node src/hub.mjs followers                  # 采粉丝
node src/hub.mjs board                      # 同步到飞书多维表格（可选）
node src/hub.mjs daemon                     # 常驻（install-launchd.sh 装的就是它）
```

## 配置要点（`config.json`）

| 项 | 说明 |
|---|---|
| `pluginDir` | obsidian-x-publisher 的本地路径 |
| `rootPath` / `nasUrl` | 发布工程根目录；NAS 掉线或被挂到「…-1」时守护进程会自己卸掉重挂 |
| `batches` | 上传批次。一次传太多平台会互相抢带宽导致超时，建议国内两两一批 |
| `auto` / `manual` | 自动提交 / 等你点发布的平台 |
| `keepAlive` | 容易掉登录的平台（视频号），定时刷一下保活 |
| `site` | 自有站点，可选，见下 |
| `board` | 飞书多维表格看板，可选 |
| `web.key` | 网页口令，所有页面和接口没有口令一律 401 |

## 自有站点（可选）

不配 `site` 就整块关掉：不建课、不采注册，网页隐藏站点卡片和「转化」页。要接自己的站，提供两个接口（麦田用专用 Chrome 里的管理员登录态去调）：

- `coursesApi` → `{ courses: [{ _id, title, seriesId, visibilityStatus, viewCount, publishedAt }] }`
- `dashboardApi` → `{ funnel: { totalRegistered }, registrationTrend, revenueTrend, channelStats, campaignStats? }`

字段细节见 `src/site.mjs` 顶部注释。

## 各平台的坑（实战总结）

- **国内四家由你自己点最终发布**。自动化只负责填写和核对，最后一下人点，降低风控风险。
- **小红书只走最保守的路**：只读页面上已经渲染的内容、像人一样滚动和点击，不在页面里直接调它的接口，低频。
- **同一条视频每个平台只上传一次**，反复重传最容易触发风控；中控的防重就是为这个。
- **视频号的定时可能被改**：表单回读是对的，提交后平台记成别的时间（遇到过 +2 小时）。`sync` 会拿平台记录的定时和计划比对，不一致发 ⚠️ 卡片。
- **YouTube 上传对话框被关掉**时，视频可能已经排好定时；中控会先查 Studio 列表再下结论。
- **成片必须 faststart**（moov 在文件头），否则小红书报「无视频流信息」、抖音不出表单；校验会拦。
- **专用 Chrome 卡死**：用 `curl 127.0.0.1:9333/json/close/<id>` 关掉卡住的标签页，不会触发「离开此网站」确认。

## 远程访问（可选）

`scripts/install-launchd.sh --tunnel` 会装一个 cloudflared 快速隧道，把 8787 映射成 `https://xxx.trycloudflare.com`，地址变了推飞书。快速隧道重启后地址会变；要固定域名用 Cloudflare 命名隧道。

## 数据和隐私

- `config.json`、`data/`（数据库、日志）、`chrome-profile/`（各平台登录态）都不进 git。
- 麦田只读你自己账号的创作者后台数据，不做互动自动化、不碰别人的账号。

## License

MIT
