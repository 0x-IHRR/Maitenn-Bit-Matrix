# 比特媒体矩阵工作台

基于[麦田](https://github.com/CzzzzzzJ/mdldm-maitian)已有的大屏、流量、日历、转化、档案、系统模块，服务比特浏览器中的媒体矩阵。当前先接入 X。

## 运行

需要 Node 24，以及本机已安装并登录好的比特浏览器（Local API 默认 `http://127.0.0.1:54345`）。执行 `npm start`，打开 http://127.0.0.1:8790/ 。

在系统页：

1. 保存比特 Local API 地址，发现并纳管环境，把已登录的自有号绑到对应窗口。
2. 添加对标号（只读公开数据，不打开比特）。备注、标签、启停、解绑和删除也在这一页。
3. 保存采集计划。默认定时关闭；打开后按 Asia/Shanghai 的小时跑，每天 1 或 2 次，账号之间随机间隔数分钟，并发 1 或 2。
4. 自有号采集会在窗口没开时调用 `/browser/open`，结束后只 `/browser/close` 这次打开的窗口。你本来开着的窗口不会关。遇到登录页、验证码或限流会暂停该号，面板顶部告警，不会连着重试。
5. 帖子从主页时间线自动发现最近 N 条（默认 20），之后继续追踪，不再靠麦田 `publish.json` 当帖子来源。

对标号每天的数据也可以从本机导入，例如 Grok Bot 读到的 JSON：

```bash
curl -s http://127.0.0.1:8790/api/bt/external-import \
  -H 'content-type: application/json' \
  -d '{"identity":"example","followers":10,"source":"grok-bot","posts":[{"id":"1234567890123456789","text":"hello","metrics":{"views":3,"likes":1,"replies":0,"reposts":0,"bookmarks":0}}]}'
```

这个导入接口只接受本机访问，不跟当前页面的查看范围绑定。其余写操作要在页面里做。不保存账号密码，不调用付费 X API，也不做点赞、关注、评论、转发、发帖或私信。

云端环境没有比特浏览器，自动化测试使用模拟的 Local API 和公开源。`npm test` 可在没有比特的机器上跑。

本项目独立初始化 `data/config.json`、`data/workbench.db`、`data/matrix.db`。不自动读取或复制其他麦田实例的配置、凭据和数据。没有矩阵数据时展示空状态；通知与转化集成需在本项目单独配置。采集计划实际写在 `data/matrix.db`，`config.example.json` 里的 `matrix` 是推荐值。

## 维护

`npm test` 运行测试。需求、边界和验证记录只维护在 [PRD.md](PRD.md)。

麦田通用源码按 MIT 许可复用，原许可保留在 `LICENSE`。取链接引擎的纯代码依赖固定在 `vendor/maitian-publisher`，其版本来源和 Apache-2.0 许可分别见该目录的 `UPSTREAM.json`、`LICENSE`；不会从其他浏览器资料目录自动发现引擎。
