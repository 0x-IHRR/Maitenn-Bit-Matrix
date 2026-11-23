# 比特媒体矩阵工作台

基于[麦田](https://github.com/CzzzzzzJ/mdldm-maitian)已有的大屏、流量、日历、转化、档案、系统模块，服务比特浏览器中的媒体矩阵。当前先接入 X。

## 运行

需要 Node 24。执行 `npm start`，打开 http://127.0.0.1:8790/ 。在系统页配置比特连接、确认 Profile 与账号归属，再手动更新数据。

本项目独立初始化 `data/config.json`、`data/workbench.db`、`data/matrix.db`。不自动读取或复制其他麦田实例的配置、凭据和数据。没有矩阵数据时展示空状态；通知与转化集成需在本项目单独配置。

## 维护

`npm test` 运行测试。需求、边界和验证记录只维护在 [PRD.md](PRD.md)。

麦田通用源码按 MIT 许可复用，原许可保留在 `LICENSE`。取链接引擎的纯代码依赖固定在 `vendor/maitian-publisher`，其版本来源和 Apache-2.0 许可分别见该目录的 `UPSTREAM.json`、`LICENSE`；不会从其他浏览器资料目录自动发现引擎。
