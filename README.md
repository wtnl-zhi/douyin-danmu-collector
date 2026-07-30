# 直播弹幕采集器桌面版

本项目实现了计划文档中的首版桌面应用：输入抖音直播间 URL 后，通过隔离 Chrome 的 DevTools WebSocket 链路实时抓取弹幕，持续写入 SQLite，并提供实时列表、筛选、屏蔽词、导出和关键词云。

## 已实现功能

- 单直播间开始/停止采集、状态和自动重连
- CDP `Network.webSocketFrameReceived` + gzip/Protobuf `WebcastChatMessage` 解码
- SQLite WAL 持续写入，按 `session_id + message_id` 去重
- 实时弹幕列表：时间、用户 ID、用户名、内容；支持搜索、时间范围、暂停显示、ID 脱敏和屏蔽词
- 历史采集任务浏览
- CSV（Excel 中文兼容）、XLSX、SQLite 导出
- Canvas 实时投影的蓝色 3D 关键词云：可拖动旋转，词语按景深缩放/淡出，不会翻转到背面
- 可离线打开的同款 3D HTML 关键词云导出
- 数据目录、原始帧保存、屏蔽词等本地设置

## 开发启动

```bash
cd /Users/zhi/Documents/Codex/2026-07-29/new-chat/outputs/douyin-danmu-desktop
npm install
npm run dev
```

首次启动会创建隔离 Chrome Profile。默认以**后台静默模式**运行，不会弹出浏览器窗口；如直播间要求首次登录或出现验证，可在“设置”中关闭“静默抓取（后台 Chrome）”，手动登录后再恢复静默模式。

## 校验与构建

```bash
npm run check
npm run build
npm run package
```

`npm run package` 会生成 macOS DMG。应用运行数据默认位于 Electron 的 `userData/data` 目录，包含 SQLite 数据库、隔离 Chrome Profile 和日志。

## 下载已打包程序

发布版本将附带 macOS Apple Silicon（ARM64）DMG。请从 GitHub Releases 下载，并用 `docs/SHA256SUMS.txt` 校验安装包。首次运行因未公证可能被 macOS 拦截；在 Finder 中按住 Control 点击应用并选择“打开”即可。

## 数据模型

- `capture_sessions`：采集任务、状态、开始/结束时间、计数和重连次数
- `danmu_messages`：消息 ID、用户 ID、用户名、时间、内容和源帧关系
- `raw_ws_frames`：可选的原始二进制 WebSocket 帧
- `app_settings`：本地显示与采集设置

详细范围、验收标准和未来扩展见同级的《项目开发计划与交付说明.md》。

## 第三方组件

3D 排版使用 [`react-icon-cloud`](https://github.com/teaguestockwell/react-icon-cloud)（MIT）封装的 TagCanvas 2.11 引擎。该引擎按 LGPL-3.0-or-later 提供；其来源和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
