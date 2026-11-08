# dsh-markdown-outline

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供飞书文档式的 Markdown 目录：把 AI 回复中的 Markdown 标题整理成左侧独立分栏的可折叠目录树，并支持同时检索标题与回复正文——包括尚未分页加载到浏览器里的历史轮次。

## 功能

- **整段会话目录。** 标题来自宿主侧对完整会话日志折叠出的投影，滚出已加载窗口的回复依然在目录里；点击时会按需翻页加载对应历史。
- **独立分栏。** 目录挤压对话区而不是浮在正文之上，可收成细条触发器，也可拖动调整宽度（180–420 px），两个选择都按浏览器记忆。
- **标题检索。** 命中的标题留在原层级，父级标题以浅色面包屑保留，命中处不丢失章节上下文。
- **正文检索。** 段落、列表项、引用块、表格与代码围栏都会命中并给出高亮摘要，思考过程块跳过。已加载轮次在浏览器即时检索，更早的未加载轮次经鉴权路由在宿主侧检索。
- **段落级跳转。** 结果滚动到命中的具体块，而不只是所在章节；跳转前会展开折叠祖先并按需翻页，落点短暂高亮。
- **多选引用。** 打开多选后勾选任意标题，选中的章节会汇集到输入框上方的引用卡片；点击卡片在侧边栏查看每段全文，卡片负责把它们插入草稿，随下一条消息一起发送。
- **隐藏轮次。** 勾选不再想给模型看的轮次并隐藏，它们会从对话和后续请求中消失，同时保留在目录下方的列表里，随时可以恢复。
- **跟随主题。** 只使用 `--dsw-alias-*` 设计令牌，深色与浅色主题下无需独立配色。

## 安装

本包是一个 profile bundle。装进你使用的 profile，然后刷新页面：

```sh
dsh plugin --profile web add github:sweet-boby/dsh-markdown-outline
```

也可以直接从本仓库安装：

```sh
dsh plugin --profile web add git+https://github.com/sweet-boby/dsh-markdown-outline.git
```

bundle 会向 profile patch 插入一行 `md-outline`，卸载本包时该行一并移除。

## 运行要求

- DSH 0.2 及以上，Web 或桌面端。
- 宿主侧注册 `mdOutline` 会话投影、`GET /md-outline/search` 检索路由，以及 `POST /md-outline/hide`、`POST /md-outline/restore` 两条改写路由。缺少投影注册表时目录面板保持为空；缺少检索路由时正文检索只覆盖已加载的轮次；缺少改写路由时多选引用仍然可用。

## 实现说明

| 文件 | 职责 |
|---|---|
| [`index.js`](index.js) | 宿主侧：`mdOutline` 投影单元把 `turn/start`、`user/message`、`assistant/message` 折叠成按轮次的标题目录，另提供经鉴权的全日志正文检索路由、隐藏轮次的提示词上下文，以及隐藏/恢复路由 |
| [`client.js`](client.js) | 客户端：头部桥接、分栏目录面板、检索、多选、引用卡片与侧边栏、隐藏轮次列表与跳转逻辑 |
| [`cordis.patch.yml`](cordis.patch.yml) | 挂载本 bundle 的 profile patch 行 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理器中显示的插件标题与描述 |

客户端挂载三个槽位：`conversation.session.header.actions` 中的会话作用域桥接读取投影、已加载轮次与翻页接口；`conversation.header.leading` 中的根作用域宿主渲染目录栏，并按面板宽度让 `[data-conversation-content]` 让位；`conversation.input.dock` 中的会话作用域条目渲染引用卡片、详情侧边栏与隐藏确认框，并独占写输入框的能力。

### 隐藏一个轮次

勾选一轮就隐藏整轮：这一轮的提问和回复一起离开模型可见面，没有勾选的轮次保持原样。轮次标题上的勾选框会一次性写入该轮的全部标题，一次操作覆盖一次完整问答。

隐藏会追加一条带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的 `user/message`，覆盖所选轮次的 surface 节点：模型可见的 surface 不再包含它们，而事件日志保留全部原始事件。一次 `replace` 只能遮蔽一个连续区间，因此两个被勾选轮次之间若有空隙，会从空隙处另起一段，而不是把区间拉宽——这正是未勾选轮次不会被一起隐藏的原因。替代消息会写明被隐藏的轮次，并要求模型不要引用它们。两条可忽略的插件记录 `plugin:dsh-markdown-outline/hidden-turn` 与 `plugin:dsh-markdown-outline/hidden-turn-restored` 构成持久账本；运行时提示词上下文在每次请求前从 live session 日志读取该账本，因此模型也知道哪些轮次不在上下文中。恢复只写入一条移除这些轮次的账本记录并追加一条说明消息——原始消息不会被重新放回 surface，因为 DSH 无法把已被遮蔽的事件重新引入。

## 测试

```sh
npm test
```

测试跑在 Node 内置的测试运行器上，不依赖任何第三方包。[`tests/hidden-turns.test.mjs`](tests/hidden-turns.test.mjs) 覆盖宿主侧规则——哪些 surface 节点属于某一轮、勾选的轮次如何切成连续替换段、账本与投影如何折叠隐藏与恢复；[`tests/client.test.mjs`](tests/client.test.mjs) 在伪 DOM 下挂载客户端，断言被隐藏的轮次会离开目录栏，且聊天区规则精确点名被隐藏的轮次。

`tests/fixtures.mjs` 按 agent loop 的真实追加顺序写事件日志（`turn/start`、`step/start`、运行时上下文、提问、回复、`step/end`、`turn/end`），因为轮次与 surface 规则依赖这个顺序。

## 已知限制

- 标题识别覆盖非思考文本中的 ATX（`#`）与 Setext（`===`、`---`）两种写法；模型写在嵌套引用或列表续行里的标题沿用渲染器降级后的层级，折叠 details 块内的标题不会被提取。
- 正文检索单次最多返回 80 条命中并标记截断，极其常见的词可能漏报靠后的匹配。
- 目录是左缘的固定分栏，不会停靠到右侧栏。
- 引用以 `<md-outline-reference>` 标签包裹的纯文本插入，占用草稿的插入点，而不是结构化的引用芯片。
- 隐藏需要活动会话，因此当前页面必须打开着该会话；恢复会把轮次标记为可见，但无法把它们的消息重新放回模型历史。

## 许可证

[MIT](LICENSE)
