# 方正矩阵助手 · 安装指引

这是只读的多 X 账号监控面板。不要安装发布 skill，不要打开平台发布页，也不要配置知识站。

## 前置条件

- macOS 或 Windows
- Node.js 24 或更高
- 自有号使用本机比特浏览器，Local API 默认 `http://127.0.0.1:54345`
- 对标号不登录，只读公开接口

## 启动

在本仓库根目录：

```bash
npm start
```

浏览器打开 http://127.0.0.1:8790/ 。第一次启动会在 `data/config.json` 写入推荐配置，示例见 `config.example.json`。

Windows 也可以双击 `scripts/windows/4-start.bat`。macOS 开机自启使用 `scripts/install-launchd.sh`，它启动的是 `src/matrix/launch.mjs`。

## 面板里做什么

1. 系统页保存比特地址，纳管环境，绑定自有号，添加对标号。
2. 需要时打开比特环境，让用户自己在窗口里登录。程序不收集密码，也不代点发布、点赞、关注、评论、转发或私信。
3. 保存采集计划。默认定时关闭；打开后按 Asia/Shanghai 每天 1 或 2 次，账号之间随机间隔。
4. 在大屏、流量、档案里查看粉丝、帖子、第 1/3/7 天复盘、上周周报和健康红条。

## 不要做的事

- 不要运行已经删除的 `src/hub.mjs`、`src/init.mjs`、`src/make-publish.mjs`。
- 不要把发布 skill 链到 Agent 的 skill 目录。
- 不要把比特 API 指到本机以外的地址。
