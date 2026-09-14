# chatgpt-cdp-cli

通过 Chrome DevTools Protocol (CDP) 驱动 ChatGPT 网页版的命令行工具：列出项目与会话、读取消息、发送提问并获取回复。

**纯页面模拟**（点击 / SPA 导航），本工具不发起任何 backend-api 或 `/api` 请求。默认面向 AdsPower 的 SunBrowser 浏览器（每次启动 CDP 端口随机，自动发现），也可通过 `CDP_PORT` 指向任意 Chrome 系浏览器的调试端口。

## 前置条件

- **AdsPower 正在运行，且 SunBrowser 中已登录 ChatGPT**（网页版 `chatgpt.com`）。
  - 不设置 `CDP_PORT` 时，工具会从运行中的 SunBrowser 进程自动发现 CDP 端口（读取 `<user-data-dir>/DevToolsActivePort`）。
  - 使用其他浏览器时，请以 `--remote-debugging-port=<port>` 启动并设置 `CDP_PORT`。
- **运行时**：Node.js ≥ 22（使用原生 `WebSocket` / `fetch` 全局对象），或 Bun ≥ 1.0。

## 安装与使用

无需安装，直接用 npx 运行（包内已带预构建产物，安装时不执行任何构建）：

```sh
npx chatgpt-cdp-cli ports
```

或全局安装：

```sh
npm i -g chatgpt-cdp-cli
chatgpt-cdp-cli ports
```

也可从源码构建**单文件可执行程序**（需要 Bun）：

```sh
git clone https://github.com/1WorldCapture/chatgpt-cli.git
cd chatgpt-cli
bun install
bun run build                 # 产出 dist/ 下的 npm 产物与 build/chatgpt-cdp-cli 可执行文件
./build/chatgpt-cdp-cli       # 不带参数即打印用法（等价于 --help，见“命令参考”）
```

## 命令参考

```
chatgpt-cdp-cli ports                        # 列出 AdsPower SunBrowser 的 CDP 端口
chatgpt-cdp-cli url                          # 当前会话绑定标签页的 URL
chatgpt-cdp-cli list-projects                # 侧边栏项目列表 [{name, id|null}]
chatgpt-cdp-cli new-chat                     # 新建普通聊天（非项目）
chatgpt-cdp-cli new-project-chat "Splats" | g-p-6aa60d...   # 在项目内新建聊天
chatgpt-cdp-cli enter-project "Splats" | g-p-...            # 进入项目主页
chatgpt-cdp-cli open-chat "https://chatgpt.com/c/<uuid>" | "/c/<uuid>" | "<uuid>"
chatgpt-cdp-cli search-chat "钢笔" [limit]    # 仅搜索，返回 [{title, url}]，不打开任何会话
chatgpt-cdp-cli messages <url|path|uuid> [rounds]   # rounds 默认 1（最近一轮），-1 为全部
chatgpt-cdp-cli send-chat "<text>" [chatUrl]  # 发送消息；不带 url = 新建普通聊天
chatgpt-cdp-cli send-project-chat "<text>" <projectId|chatUrl>
```

- 输出统一为 JSON（`JSON.stringify(out, null, 2)`）。
- `send-chat` / `send-project-chat` 会等待回复完成（停止按钮消失 + 5 秒稳定），返回 `{ url, status, messages }`，`status` 为 `'done' | 'timeout'`（超时时也返回已生成的部分文本）。
  - 已知残留：生成中途若出现 >5 秒且无停止按钮的停顿，在 DOM 层面与完成不可区分；本工具不做自我校验，调用方如需确认可再执行 `messages`。
- `send-chat` / `send-project-chat` 可用第三个参数指定推理强度：`instant | medium | high | extra high | pro`（默认 `high`）。
- 环境变量 `CDP_PORT`：可选的端口覆盖；优先级为 显式端口 > `CDP_PORT` > 自动发现。

## 架构

```
src/
  cli.ts                 CLI 入口：参数解析与命令分发（bin）
  index.ts               库入口：导出 agent 可用的 API
  api.ts                 发送工具 sendChat / sendProjectChat 与共享发送流程
                         （完成检测 v4：按末轮消息 id 判定，绝不按轮数计数）
  refs.ts                聊天引用归一化（URL / 路径 / 裸 uuid → 规范路径）
  discovery.ts           SunBrowser CDP 端口发现（ps + DevToolsActivePort）与端口解析
  types.ts               共享类型
  util.ts                小工具（json 字面量嵌入、sleep）
  cdp/
    session.ts           CdpSession：页面级 WebSocket 会话 + poll 轮询原语
    connection.ts        connect()：绑定第一个 chatgpt.com 标签页
    tabs.ts              标签页管理：后台新建标签、按会话“找到或打开”
  pages/
    composer.ts          输入框原语（textarea 与 contenteditable 双形态）
    navigation.ts        new-chat / new-project-chat / open-chat 导航
    projects.ts          侧边栏项目：listProjects / enterProject
    search.ts            侧边栏搜索（只搜索，绝不导航）
    messages.ts          消息读取：轮次提取、懒加载全量线程、getMessages
    effort.ts            推理强度滑块（可信 CDP 输入事件拖拽）
```

关键不变量（自原型逐字保留在各模块头注释中）：

- 完成检测残留（>5 秒无停止按钮的生成停顿不可区分，见 `src/api.ts`）；
- 项目 URL 形态 `/g/<g-p-id>-<slug>/project`，仅存 id 即可（裸 `/g/<id>` 会重定向，见 `src/pages/projects.ts`）；
- 输入框在 `/` 上是 `<textarea>`、项目页是 contenteditable `<div>`（见 `src/pages/composer.ts`）；
- ChatGPT 虚拟化渲染线程（DOM 只保留最近 ~5 轮，完成检测必须按消息 id，见 `src/api.ts`）。

## 开发

```sh
bun install
bun test          # 单元测试（无需浏览器）
bun run typecheck # tsc --noEmit
bun run build     # dist/ npm 产物 + build/ 单文件可执行程序
```

- `dist/` 为**预构建产物，直接检入仓库**：npm 包与 GitHub 安装（npx from git）都不在安装时执行构建。
- 新聊天只有在发出第一条消息后才会落定为 `/c/<uuid>`；发送工具会轮询捕获该 URL。
- 删除的会话会静默重定向到新聊天；发送前会校验目标 URL 包含预期会话 id，防止发错位置。

## 许可

待定（发布到 npm 前需补充 LICENSE）。
