# 宠物问诊室

手机打开「病例管理」，选择「新建病例」，填写想练的病例范围，留空则随机生成。病例难度可选入门、中等、高难或随机，分别覆盖常见门诊、需要进一步检查或判断是否手术的病例，以及老年、神经内科等复杂病例。家长难度单独选择，也可按需开启急诊时间压力、治疗沟通或双病共存。生成后先查看「档案」，了解宠物和家庭照护者的资料，再点「开始接诊」。

在「接诊」中，用户扮演兽医，AI 扮演宠物家长。可以问病史、做检查、实施处置、沟通治疗和给出诊断判断。检查当轮出结果并归档到「检查」。每轮可在消息上方填写想法或备注，随该轮保存并显示在自己的消息上方，供复盘评价。点击「结束接诊并复盘」，可在独立的「复盘」页签查看诊断、评分、接诊反馈和备注评价。

需要练习手术时，先结合病情判断是否适合手术和选择什么术式，再切换到「手术」页。可以讨论计划或逐轮描述实际执行的操作，模拟会根据已出检查、病例状态和正式操作返回术中所见或监护变化。手术页也可以单独填写本轮想法，正式操作与备注一同纳入复盘。无需手术时留空即可。

想直接试用手术流程，可以在「接诊」发送「【我要测试一下手术功能】」。页面会打开「手术」并记录模拟反馈，之后可在该页继续操作。

术中有变化时，可切回「接诊」通知家长并征询意见，再回到「手术」继续。术后也可在「接诊」解释结果。家长根据实际告知和亲眼看到的动物表现回应，医生仍可请求客观观察或检查。

病例管理页的「系统帮助」提供完整使用指南，旁边的「助手」可回答平台用法。病例内的「病例助手」根据当前公开档案、对话和报告提供提示，助手对话随该病例保存。两个对话入口各用自己的历史记录。

病例、接诊、检查和复盘通过 IndexedDB 保存在当前浏览器和站点来源下，刷新后可在病例列表中重新打开。可以在「档案」删除病例及其记录。清理站点数据会清除本机病例。[case-store.mjs](docs/case-store.mjs) 提供独立的异步存储接口，病例 ID、创建和更新时间、修订号都随记录保存。

## 配置 API

编辑 [docs/config/api.json](docs/config/api.json)，填写 `baseUrl`、`model` 和接口需要的 `apiKey`。支持 OpenAI 兼容的 Chat Completions 接口。`baseUrl` 可以是带版本路径的 API 基址（如 `https://api.openai.com/v1`），也可以是完整的 `/chat/completions` 地址。

- `headers` 可选，用来填写服务商要求的额外请求头。`apiKey` 有值时会发送 `Authorization: Bearer …`。
- 当前 `openai.chatnewai.com` 配置将令牌填在 `headers.mj-api-secret`，并留空 `apiKey`。该网关接受这个鉴权头，跨域预检返回的 `Access-Control-Allow-Headers: *` 也允许它。更换 API 服务时，按新服务的要求填写鉴权配置。 [New API 鉴权实现](https://github.com/QuantumNous/new-api/blob/main/middleware/auth.go)
- `parameters` 可选，可填写模型支持的参数，例如 `temperature`。网页默认使用 Chat Completions 流式回复。对不支持流式输出的服务，可以设 `stream: false`。模型需要能根据预设返回 JSON，病例开场或回复字段放在首位时，网页可随流显示这段内容。
- Pages 使用 HTTPS。API 服务需要允许从站点来源发起跨域 POST 请求。使用 Bearer 令牌时，API 的 OPTIONS 响应须在 `Access-Control-Allow-Headers` 中明确列出 `Authorization, Content-Type`。 [Fetch 标准](https://fetch.spec.whatwg.org/#cors-preflight-fetch)
- 三个配置文件均随网站公开。任何访客都可以读取写入文件的令牌。模拟病例底稿随病例存在浏览器本地，可通过开发者工具查看。接诊和助手所需上下文会发送给配置的模型服务。

## 扩展预设和世界书

[docs/config/preset.json](docs/config/preset.json) 的 `messages` 支持 `system`、`user`、`assistant` 三种角色。系统项合并到第一条 `system` 消息，示例项按配置顺序放在真实对话之前。文件提供了一组默认关闭的用户与助手示例。设置 `enabled: true` 可启用。`tasks` 定义各阶段的提示词和模型输出结构。用 `stages` 限定适用阶段，例如 `case`（生成病例）、`consultation`（接诊）、`review`（最终复盘）、`helper`（病例助手）和 `help`（系统帮助）。两种助手模式只加载显式适用该阶段的预设消息。

默认生成犬猫病例。练习其他物种时，在病例范围中明确填写物种，例如「兔子 + 食欲不振」。默认世界书中的临床条目在接诊和复盘中提供记录方法，病例生成按用户给出的范围开放构造。

检查报告用 `rows` 保存定量或定性指标，每行有 `label`、`value`、`unit`、`reference` 和 `flag`。影像所见等描述用 `sections` 保存，每段有 `title` 和 `text`。网页会在检查结果页签中将两者分别呈现为表格和报告段落。

在 [docs/config/worldbook.json](docs/config/worldbook.json) 的 `entries` 数组内追加条目即可扩展知识库。例如：

```json
{
  "title": "老年犬活动史",
  "keys": ["老年犬", "上楼", "活动量"],
  "stages": ["consultation", "review"],
  "position": "system",
  "priority": 25,
  "content": "关注活动量变化、起身和上下楼表现、体重变化以及长期用药史。"
}
```

条目匹配病例设定和最近 `scanDepth` 条对话，关键词命中任意一个即可，英文忽略大小写。`always: true` 使条目在对应阶段常驻。`enabled: false` 可停用。匹配后按 `priority` 从高到低分配 `maxChars` 字符预算，同优先级按文件顺序。

| `position` | 插入位置 |
| --- | --- |
| `system` | 默认值，放入首条系统消息，位于预设系统文本与病例底稿之间。 |
| `beforeHistory` | 放在预设示例之后、真实对话之前。 |
| `afterHistory` | 放在已有对话之后、本轮用户消息之前。 |
| `depth` | 从历史末尾计数，`depth: 1` 紧邻本轮用户消息之前，`depth: 2` 再往前一条。 |

后三种位置支持通过 `role` 设置插入项的角色，默认 `system`。

## 预览与发布

在 Windows 双击仓库根目录的 [preview.bat](preview.bat)。脚本会在本机的 8001 端口启动预览并打开默认浏览器。测试完成后关闭脚本窗口，或按 `Ctrl+C` 停止预览。

本地用静态 HTTP 服务打开 `docs`，例如在仓库根目录运行：

```sh
python -m http.server 8001 --bind 127.0.0.1 --directory docs
```

浏览器打开 `http://127.0.0.1:8001/`。运行 `node --test` 可验证消息组装、结果解析和 API 请求逻辑。

如果旧版 Python 将 `.mjs` 返回为 `application/octet-stream`，使用下面的预览命令显式指定 JavaScript 类型。

```sh
python -c "import functools,http.server; http.server.SimpleHTTPRequestHandler.extensions_map['.mjs']='text/javascript'; handler=functools.partial(http.server.SimpleHTTPRequestHandler,directory='docs'); http.server.ThreadingHTTPServer(('127.0.0.1',8001),handler).serve_forever()"
```

将项目推送到 GitHub 后，在 **Settings → Pages → Build and deployment** 选择 **Deploy from a branch**，来源设为 **main /docs**，然后保存。网页和三个配置文件都通过相对路径加载，无需构建。 [GitHub Pages 发布说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
