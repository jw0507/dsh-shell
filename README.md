# dsh-shell — DeepSeek Harness 纯壳启动器

零依赖（只需 Node ≥ 20）、绿色目录、隐藏后台运行。

**核心承诺：关掉任何窗口都不会停 dsh 服务。** 停止 dsh 只有一条路——在面板里点「停止服务」。

## 特性

- **无命令窗口**：后台隐藏运行，双击启动，全程没有需要照看的黑色窗口；
- **生命周期解耦**：关面板、关显示器、退出壳、杀壳进程，dsh 都照常运行；
- **DSH 显示器**：dsh 就绪后自动拉起一个全尺寸独立窗口显示 dsh UI（工作区不缩水），关闭它不影响 dsh，随时可再拉起；
- **原生更新 + 国内镜像兜底**：更新走官方 `npm install @deepseek-ai/dsh@latest`，4 个镜像自动轮换（npmmirror → 腾讯 → 华为 → npmjs），国内网络也能正常安装/更新；
- **启动自动检查更新**：启动后后台快速获取官方最新版本——有新版本时面板提示并可一键升级，无新版本时不打扰；
- **全新设备零门槛**：未安装 dsh 也不怕，面板点「一键安装 / 更新」自动装好并初始化；
- **安全**：外部 dsh 进程默认锁定（避免误杀）、控制面板仅绑定 `127.0.0.1`、无需管理员权限；
- **独立窗口**：DSH 显示器是 **WebView2 原生窗口**（复用系统 Edge 引擎，无标签页/地址栏），壳本体仍是零依赖 Node；
- **任务栏独立身份 + 独立图标**：显示器宿主 exe 内嵌官方 DSH 图标——透明背景 + 黑色官方 logo（浅色任务栏适配），按微软 Fluent 图标网格规范（内容占画布 88%）；`make-icon.ps1` 从官方 `favicon.svg` 矢量渲染（`-Color white` 可生成深色任务栏用白色版）；启动时通过 `SetCurrentProcessExplicitAppUserModelID` 设置独立应用身份——任务栏/Alt-Tab 与 Edge 分离，标准 Win32 机制、100% 可控。

## 架构

```
┌──────────────────────────────────────────────────┐
│ 后台（无窗口）                                     │
│   dsh 本体 = 独立 node 服务进程（默认 3080）        │
│   壳       = 独立 node 进程（默认 3081）           │
│             只负责启停 / 更新 / 状态 / 日志        │
└──────────────────────────────────────────────────┘
   ├─ 面板窗口（小）   ← 控制中心（Edge App 独立窗口）
   └─ DSH 显示器（全尺寸）← 显示 dsh UI（WebView2 原生窗口，由壳拉起）
```

- 壳用 **detached 独立进程**方式启动 dsh（独立进程组/控制台）：壳退出、被杀、崩溃，dsh 都照常运行；
- 壳通过 `cmd /c` 重定向方式启动 dsh（不向 dsh 传任何句柄）：避免 dsh 继承壳的监听句柄——
  否则壳退出后其面板端口会被 dsh 手里的继承句柄锁死（netstat 显示已死的壳 PID，成为无法释放的"幽灵端口"）；
- 浏览器/独立窗口只是**显示层**：可随意开关，不影响任何后台进程。

## 系统要求

| 依赖 | 说明 |
|---|---|
| Windows 10/11 | 当前平台 |
| Node.js ≥ 20 | **唯一硬前置**（dsh 本身是 Node 程序；更新时用 npm） |
| WebView2 运行时 | DSH 显示器使用（Win10/11 通常已随 Edge 安装；缺失时自动回退浏览器） |
| Edge 或 Chrome | 面板独立窗口使用（Windows 自带 Edge；缺失时自动回退默认浏览器） |

## 快速开始

1. 把整个 `dsh-shell` 文件夹拷贝到任意位置（绿色目录，无注册表、无环境变量）；
2. 双击 `start.cmd` —— 隐藏后台启动，自动弹出控制面板独立窗口（以自动弹出的窗口为准；面板顶部会显示实际端口。默认 `3081`，被占用时自动切换 `3082+`，请勿手动猜测端口）；
3. **首次使用**：若未安装 dsh，点「一键安装 / 更新」自动安装（官方 npm + 镜像轮换）；
4. 点「启动服务」—— dsh 就绪后自动拉起 **DSH 显示器**窗口；
5. 开始使用。之后想停服务：面板里点「停止服务」；想找窗口：再双击 `start.cmd`。

> 也可以直接用浏览器访问面板实际端口（面板顶部有显示，默认 `http://127.0.0.1:3081`，被占时自动切换）。

## 使用说明

| 按钮 | 作用 |
|---|---|
| 启动服务 | 后台拉起 dsh 服务，等待就绪 |
| 停止服务 | 停止 dsh（连子进程树一起清理）。**外部进程默认锁定，点不动** |
| 重启 | 停止 + 启动 |
| 一键安装 / 更新 | 官方 `npm install @deepseek-ai/dsh@latest`；运行中会自动先停、再更、再启动。启动时已自动检查更新，有新版本会在面板高亮提示；页脚提供「重新检查更新」链接 |
| 打开 DSH 显示器 | 拉起全尺寸独立窗口显示 dsh UI（关闭它不影响 dsh） |

状态栏显示：运行中（本壳管理 / 外部进程已锁定）、本机版本、最新版本、安装位置。

> 关闭面板窗口后约 120 秒壳自动退出（dsh 服务不受影响），无需手动操作。

## 更新机制

- 壳不自行实现更新，只调用官方 npm 机制：`npm install @deepseek-ai/dsh@latest --prefix <安装根> --registry=<镜像>`；
- 多个镜像按优先级轮换，某个源卡住或失败自动切换；全部失败则中止并保留旧版本可用；
- 更新前自动停止 dsh（若在运行），更新后自动重启。

## 安全设计

- **外部进程锁定**：如果目标端口上跑着**不是本壳启动**的 dsh（例如其他方式启动的实例），
  壳显示“运行中（外部进程，已锁定）”，并禁用 停止/重启（避免误杀）；「一键安装 / 更新」仍可用，
  但仅安装到安装根、不停止/不重启现有实例（需自行重启后生效）。
- 控制面板只绑定 `127.0.0.1`，不对外网开放；
- 不需要管理员权限，不做任何提权操作。

## 配置（config.json）

| 字段 | 默认值 | 说明 |
|---|---|---|
| shellPort | 3081 | 控制面板端口（被占用时自动打开已有面板并退出） |
| dshPort | 3080 | dsh Web UI 端口 |
| dshPackage | @deepseek-ai/dsh | 要管理的 dsh 包名 |
| installRoot | %LOCALAPPDATA%\dsh-cli | dsh CLI 安装根（支持 %ENV% 展开） |
| nodeMinMajor | 20 | Node 版本下限 |
| autoOpenBrowser | true | 启动时自动打开控制面板 |
| autoCheckUpdate | true | 启动后后台快速检查最新版本（有新版才提示） |
| autoOpenDshWindow | true | dsh 就绪后自动拉起 DSH 显示器 |
| windowMode | webview2 | `webview2` = DSH 显示器用 WebView2 原生窗口（默认，图标/任务栏分组可控）；`edge-app` = Edge 独立窗口（兜底）；`browser` = 默认浏览器 |
| mirrors | 4 个镜像 | 更新/安装时的镜像轮换列表 |

## 体积说明

壳本体约 55KB。`display/` 目录为 DSH 显示器宿主（exe 约 115KB，含多尺寸内嵌图标 + 官方 WebView2 SDK 三个 DLL 共约 0.8MB）。
面板使用 Edge 独立实例目录（`data/edge-profile-panel`），已通过 `--disk-cache-size`（1MB）和 `--disable-component-update` 限制增长；
DSH 显示器的 WebView2 数据目录在 `%LOCALAPPDATA%\dsh-shell\webview2-display`（体积受控，可随时删除重建）；
启用 WebView2 模式后，旧的 Edge 显示器 profile（`data/edge-profile-dsh`，约 300MB）会在下次启动时自动回收。

## 目录结构

```
dsh-shell/
├── dsh-shell.mjs     主程序（Node 单文件，零依赖）
├── config.json       配置
├── start.cmd         双击入口（隐藏后台拉起）
├── setup-shortcut.ps1 开始菜单快捷方式创建脚本
├── make-icon.ps1     图标生成脚本（官方 favicon.svg 矢量渲染多尺寸 ICO，`-Color white` 切白色版）
├── favicon.svg       官方 DSH 图标源文件（随 dsh 分发，已复制入项目）
├── package.json      项目元信息（可选，`npm start` 也可启动）
├── display/          DSH 显示器 WebView2 宿主（dsh-display.exe + 官方 SDK DLL + build.cmd 可复现编译）
├── LICENSE           MIT
├── README.md
└── data/             运行数据（日志、PID 标记，自动生成，可删除）
```

## 卸载

删除整个 `dsh-shell` 文件夹即可。dsh 本体位于 `%LOCALAPPDATA%\dsh-cli` 与 `~/.dsh`，是否一并删除由你决定。

## 常见问题

**Q：为什么「启动服务」不可用？**
A：目标端口（默认 3080）已有 dsh 在运行（包括其他方式启动的实例）。停止该实例或重启电脑后，由本壳启动即可获得完整控制权。

**Q：如何从其他方式启动的实例切换过来？**
A：先停止旧实例（任务管理器结束对应 node 进程，或重启电脑），再通过本壳「启动服务」。

**Q：dsh 装到哪里？**
A：默认 `%LOCALAPPDATA%\dsh-cli`。壳也会自动识别已存在的 dsh 安装并直接使用。

**Q：关掉了面板/显示器窗口，怎么找回？**
A：再双击 `start.cmd`，或浏览器访问 `http://127.0.0.1:<shellPort>`。

**Q：更新失败怎么办？**
A：壳会自动轮换镜像重试；全部失败会保留旧版本并给出日志，不会破坏现有环境。

## 设计原则

- **按需使用，不常驻**：壳是启动器不是管理器——安装/更新/启动后即可退出，dsh 独立后台运行；需要停止时再双击打开，点「停止服务」；
- 因此**不做**托盘图标、开机自启、常驻后台等"管理器"功能；
- 独立窗口基于 WebView2（复用系统 Edge 引擎，零第三方运行时）；图标/任务栏身份由原生宿主 exe 控制，无需 Electron。

## DSH 生态

- **定位**：dsh-shell 是 DeepSeek Harness 的**独立启动器/客户端**（非 dsh 进程内插件）——它从外部管理 dsh 的启动/停止/更新，并提供 WebView2 原生显示器，不修改 dsh 本身。
- **发现方式**：GitHub 仓库打了 `dsh-plugin` topic（dsh 生态官方指定的发现标签，见 [awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin)），同时可在 GitHub 按 `dsh` / `deepseek-harness` / `launcher` 等 topic 搜索到。
- **使用**：克隆或下载后双击 `start.cmd` 即可，无需编译、无需安装到 dsh profile。

## License

MIT