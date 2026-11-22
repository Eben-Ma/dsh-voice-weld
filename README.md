# dsh-voice-weld

> DSH（DeepSeek Harness）桌面版的**语音输入**插件：按下输入框右侧的麦克风说话，文字边识别边出现在草稿里；停止后可以让模型把口语顺成书面语。

**来源说明**：fork 自 [tangzheng202202/dsh-voice-live](https://github.com/tangzheng202202/dsh-voice-live)（原版是 DSH 的实时语音对话插件，WebSocket + 火山引擎 ASR/TTS）。原版的语音对话、TTS 朗读、唤醒词在本版本中**没有启用**；识别链路改成「宿主 HTTP 路由 + 阿里云百炼流式 ASR」，另外加了口语润色、词表、录音时长上限。改造明细见 [HANDOVER.md](HANDOVER.md)。

状态：自用向项目，当前 `0.2.1`，只在 Windows + DSH 桌面版上验证过。

English: a speech-to-text input plugin for the DSH desktop app. Speak into the composer, watch the text stream in, then optionally let the model rewrite your spoken words into written Chinese. Fork of `dsh-voice-live`, reworked to use Alibaba DashScope streaming ASR over host HTTP routes.

---

## 它解决什么问题

打字慢、懒得打字、或者手上有别的事——按一下麦克风说话，文字直接进输入框，不用切输入法、不用一段段敲。识别是流式的：你说到哪，字就出到哪，随时能看到识别对不对。

适合：写长段落的说明、口述笔记、把脑子里的话一次性倒出来。

不适合：嘈杂环境（没有降噪）、需要中英日多语种混说（目前只针对中文和中英混说调过）。

## 装之前需要准备

| 需要 | 说明 |
|---|---|
| DSH 桌面版 `0.2.x` | peer 要求 `>=0.2.0-rc.2 <0.3.0-0`，更老或更新的版本不保证能装 |
| 阿里云百炼 API Key | 在[百炼控制台](https://bailian.console.aliyun.com/)开通后获取，形如 `sk-...`。识别按音频时长计费，很便宜 |

## 安装

目前没有发布到 npm，也没有 Release 包，只能从 git 装。

```sh
# 1. 装进你的 profile（把 desktop 换成你自己在用的 profile 名）
dsh plugin --profile desktop add github:Eben-Ma/dsh-voice-weld

# 2. 让它作为 bundle 被加载：编辑该 profile 的 package.json，
#    把 "dsh-voice-weld" 加进 dsh.profile.bundles 数组
# 3. 完全退出 DSH 再打开；客户端插件需要刷新页面才会出现按钮
```

第 2 步容易漏：**只装依赖不会加载插件**，bundle 列表里有名字才会被挂上。

## 配置 API Key

Key 只存在宿主进程里，浏览器（前端）从头到尾不碰它——所以设置页里没有填 Key 的输入框，这是刻意的。

两种给法，任选一种：

**方式一：环境变量**（临时、适合调试）

```sh
DASHSCOPE_API_KEY=sk-你的key
```

**方式二：写进 DSH 凭据文件**（推荐）

编辑 `~/.dsh/.credentials.yaml`，在 `refs` 段加一行：

```yaml
refs:
  DASHSCOPE_API_KEY: sk-你的key
```

改完重启 DSH 生效。取不到 Key 时，点麦克风会直接提示「未找到 DASHSCOPE_API_KEY」，不会静默失败。

## 怎么用

1. 打开任意会话，点输入框**右侧**的麦克风
2. 说话，文字实时出现在草稿里；每轮都是在你已有内容后面**追加**，不会覆盖
3. 点停止（或按到时长上限自动停）——如果润色力度不是 0，这时会把口语整理成书面语
4. 说错了想重来：录音中按 `Esc`，草稿还原到这一轮开始前

## 设置

设置页里的「**语音输入（百炼）**」分区：

| 项 | 说明 |
|---|---|
| 整理力度（0–3） | `不改写` 只补标点；`轻度` 补标点、规范数字；`标准` 去口癖和重复、分句；`较强` 会合并被停顿切碎的半句、微调语序，但不增删信息 |
| 单次录音时长上限 | 1–60 分钟，默认 10。到点自动停止并提示，不会悄无声息地断 |
| 词表 / 上下文 | 最多 400 字，专有名词（人名、术语、产品名）写进去，识别时会优先选它们。保存后**下一次录音**生效 |

## 它稳在哪

- **长录音不会自己断**：分三层超时——建连 15 秒、空闲 120 秒看门狗，录音本身没有整体超时
- **不会越说越滞后**：音频按绝对时间轴推给上游，不靠逐帧 sleep 累加
- **识别侧死了不会假装在录**：上游断连或超时会收尾、保留已识别的文字、弹提示，而不是让红点一直亮
- **没有常驻进程**：随 DSH 启动、随 DSH 退出，不监听端口、不用开机自启
- **孤儿会话自动回收**：前端崩溃没来得及收尾的会话，识别完 5 分钟、仍在录 30 分钟后清掉

## 已知限制

- 润色是**整段替换**：停止后才把草稿换成书面语，上屏时会跳一下（不是逐字改写）
- 纯网络抖动（超时但会话还在）只丢那一小段音频，前端不弹窗——避免每 200 毫秒报一次错
- 没有静音自动断句：只有手动停止或到时长上限才结束（说话中间停顿太多，自动断句会切碎）
- 时长上限只管单次录音，不跨轮记忆
- 只针对中文调过，其他语言的识别质量未验证

## 排错

| 症状 | 大概原因 |
|---|---|
| 按钮和设置分区一起消失，界面不报错 | 客户端包渲染期抛错。DSH 的插件加载器对渲染错误是**静默**的，槽位直接空白 |
| 按钮根本不出现 | profile 的 `dsh.profile.bundles` 里没有 `dsh-voice-weld`，或没重启 DSH |
| 点了没反应、没有报错 | 宿主没重启（只刷新页面不够，`/api` 路由不会更新）；或 Key 没配上 |
| 说话有字但明显不准 | 词表没填；或网络丢帧 |
| 录了很久突然停、并提示「识别已中断」 | 上游断连。正常连说不会触发，看 DSH 日志里的 `asr socket closed` |
| 从外部 `curl` 打 `/api/voice-weld/start` 返回 401 | 正常：所有 `/api` 路由先过宿主鉴权，**401 不代表路由坏了** |

## 开发

```sh
npm install
node build.mjs          # 产出 lib/index.js（宿主）+ lib/client.js（前端）
npm test                # 单元测试，不需要麦克风、不出网
node _boot2.mjs lib/client.js   # 手动自检：真的把组件渲染成 HTML
```

改代码前后必看的两条：

- `build.mjs` 里客户端那段必须是 `jsx: 'automatic'`。esbuild 默认的 classic transform 会编成 `React.createElement`，而组件只 `import { useState } from 'react'`，渲染时直接 `ReferenceError: React is not defined`，**界面一个字都不报**。
- 改了宿主侧（`src/index.ts`、`src/host/*`）必须整进程重启 DSH；只改客户端刷新页面即可。

架构、协议、保留的老代码见 [HANDOVER.md](HANDOVER.md)。

## 许可

[MIT](LICENSE)。LICENSE 保留的是上游（DeepSeek）的版权声明，修改部分同样以 MIT 发布。
