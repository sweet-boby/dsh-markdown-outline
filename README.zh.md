# dsh-markdown-outline

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供飞书文档式的 Markdown 目录：把 AI 回复中的 Markdown 标题整理成左侧独立分栏的可折叠目录树，并支持同时检索标题与回复正文——包括尚未分页加载到浏览器里的历史轮次。

## 功能

- **整段会话目录。** 标题来自宿主侧对完整会话日志折叠出的投影，滚出已加载窗口的回复依然在目录里；点击时会按需翻页加载对应历史。
- **独立分栏。** 目录挤压对话区而不是浮在正文之上，可收成细条触发器，也可拖动调整宽度（180–420 px），两个选择都按浏览器记忆。
- **标题检索。** 命中的标题留在原层级，父级标题以浅色面包屑保留，命中处不丢失章节上下文。
- **正文检索。** 段落、列表项、引用块、表格与代码围栏都会命中并给出高亮摘要，思考过程块跳过。已加载轮次在浏览器即时检索，更早的未加载轮次经鉴权路由在宿主侧检索。
- **段落级跳转。** 结果滚动到命中的具体块，而不只是所在章节；跳转前会展开折叠祖先并按需翻页，落点短暂高亮。
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
- 宿主侧注册 `mdOutline` 会话投影与 `GET /md-outline/search` 路由。缺少投影注册表时目录面板保持为空；缺少该路由时，正文检索只覆盖已加载的轮次。

## 实现说明

| 文件 | 职责 |
|---|---|
| [`index.js`](index.js) | 宿主侧：`mdOutline` 投影单元把 `turn/start`、`user/message`、`assistant/message` 折叠成按轮次的标题目录，另提供经鉴权的全日志正文检索路由 |
| [`client.js`](client.js) | 客户端：发布会话状态的头部桥接、分栏目录面板、检索与跳转逻辑 |
| [`cordis.patch.yml`](cordis.patch.yml) | 挂载本 bundle 的 profile patch 行 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理器中显示的插件标题与描述 |

客户端挂载两个槽位：`conversation.session.header.actions` 中的会话作用域桥接读取投影、已加载轮次与翻页接口，`conversation.header.leading` 中的根作用域宿主渲染目录栏，并按面板宽度让 `[data-conversation-content]` 让位。

## 已知限制

- 标题识别覆盖非思考文本中的 ATX（`#`）与 Setext（`===`、`---`）两种写法；模型写在嵌套引用或列表续行里的标题沿用渲染器降级后的层级，折叠 details 块内的标题不会被提取。
- 正文检索单次最多返回 80 条命中并标记截断，极其常见的词可能漏报靠后的匹配。
- 目录是左缘的固定分栏，不会停靠到右侧栏。

## 许可证

[MIT](LICENSE)
