# 简递 · 实习岗位自动投递助手

> 一个基于 Electron + CDP（Chrome DevTools Protocol）的桌面工具，自动在多个招聘平台采集实习岗位并一键投递。

支持平台：**BOSS 直聘 · 牛客网 · 智联招聘 · 猎聘**

**下载安装包（Windows）**：[简递-Setup-1.2.3.exe（最新版）](https://jiandidi.oss-cn-shenzhen.aliyuncs.com/releases/%E7%AE%80%E9%80%92-Setup-1.2.3.exe)

---

## 它能做什么

- 按**关键词 + 城市**自动搜索实习岗位，多关键词累加去重
- 自动进岗位详情页投递简历，投过/需简历/下架/仅沟通的岗位自动分类
- 未登录时自动停下等你登录，登录后**自动回到原岗位继续投**，不打断流程
- 投递历史本地持久化，避免重复投递
- 图形界面（Electron）+ 命令行两种用法

## 目录结构

```
jiandi/
├── auto-apply.mjs         # 核心逻辑：各平台采集 / 投递 / 登录等待 / 命令行
├── lib/
│   ├── cdp.mjs            # CDP 封装：连浏览器、注入脚本、跨标签页登录识别
│   ├── cities.mjs         # 通用城市表（BOSS / 牛客）
│   ├── zhilian-cities.mjs # 智联招聘城市码（jl 参数）
│   └── liepin-cities.mjs  # 猎聘城市码（dq 参数，400+ 城市）
├── app/                   # Electron 桌面应用
│   ├── main.js            # 主进程：任务调度、IPC、更新检查
│   ├── preload.js         # 渲染层桥接
│   ├── updater.js         # 在线更新（检查 / 下载 / SHA256 校验）
│   └── renderer/          # 界面（index.html / app.js / style.css）
├── build/                 # 打包图标
├── tools/                 # 发布工具（OSS 上传 / 本地更新服务）
├── docs/                  # 使用说明、更新发布指南
├── build-electron.mjs     # 便携版打包脚本
├── hide-locales.mjs       # 语言包瘦身脚本
└── electron-builder.yml   # 安装包构建配置
```

## 快速开始

### 环境要求

- Windows 10/11（当前仅针对 Windows）
- Node.js ≥ 20
- 本机装有 Chrome 或 Edge（程序会自动探测，也可手动指定）

### 安装依赖

```bash
npm install
```

### 命令行运行

```bash
# 自检（探测浏览器 / 城市表 / 历史投递）
node auto-apply.mjs --check

# 直接投递某个平台（示例：猎聘，南宁，前端/实施关键词，单次 20 个）
node auto-apply.mjs --liepin --city=南宁 --kw="前端 实施工程师" --max=20 --yes
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--boss` / `--nowcoder` / `--zhilian` / `--liepin` | 选择平台 |
| `--city=城市` | 城市（猎聘/智联/牛客支持，BOSS 按默认城市） |
| `--kw="关键词 关键词"` | 检索关键词，**四平台共用**，空格分隔 |
| `--max=N` | 单次投递数量上限 |
| `--yes` | 免确认直接跑 |

### 图形界面运行

```bash
npm run dev
```

首次启动会自动弹出一个**专用浏览器窗口**，登录一次 BOSS / 牛客 / 智联 / 猎聘后即可开始自动投递。

## 打包

```bash
# 便携版（免安装）
npm run build

# 安装包（NSIS）
npm run bundle       # 先生成 app/core.cjs
npm run build:installer
```

> 打包前需要先 `npm install`，安装 electron / electron-builder 依赖。

## 在线更新（可选）

程序内置 OSS 在线更新。发布新版本：

```bash
# 1. 把 tools/oss.config.example.json 复制成 oss.config.json，填上阿里云 OSS 的 AccessKey
# 2. 发布
node tools/发布更新.mjs --exe="安装包路径.exe" --version=1.1.0 --notes="更新说明" --oss
```

具体见 `docs/更新发布指南.md`。**`tools/oss.config.json` 含密钥，已被 `.gitignore` 排除，切勿提交。**

## 说明

- 本工具仅供个人求职自动化使用，请遵守各招聘平台的服务条款。
- 投递动作会真实发生，请先在测试环境验证。
- 各平台页面结构可能调整，若投递按钮识别失效，会以「跳过」记录在日志中并保留实际按钮文案，便于定位。

## License

MIT
