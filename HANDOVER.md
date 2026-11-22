# dsh-voice-weld

> DSH（DeepSeek Harness）桌面版的语音输入插件。按下输入框右下角的麦克风说话，文字边识别边出现在框里；停止后可以让模型把口语顺成书面语。

- 当前版本 **0.2.1** ｜ 适用 DSH 桌面 `>=0.2.0-rc.2 <0.3.0-0`
- 安装与配置见 [README.md](README.md)

---

## 1. 这是什么

一句话：**语音转文字，直接写进 DSH 的对话框**。

| 环节 | 用什么 |
|---|---|
| 识别 | 阿里云百炼 DashScope `qwen-audio-3.1-asr-flash-streaming`（WebSocket 流式，中文为主，支持中英混说） |
| 润色 | DashScope OpenAI 兼容接口 `qwen-flash`，0–3 档力度（0 = 不改写） |
| 运行形态 | **无常驻进程**：随 DSH 加载，DSH 退出即消失；不监听端口、不需要开机自启 |

## 2. 它从哪来（演变脉络）

| 阶段 | 是什么 | 留下什么 |
|---|---|---|
| 起点 | `@goodandready/dsh-voice` + 自建 Node 代理 `dsh-voice-proxy`（监听 8787，转发到百炼） | 链路长、要常驻进程；代理没起来就表现为「按了没反应」 |
| 分支 | fork 自 [`tangzheng202202/dsh-voice-live`](https://github.com/tangzheng202202/dsh-voice-live)（语音对话 + 火山引擎 ASR/TTS 的完整实现） | 客户端 UI、槽位注册、录音管线的骨架 |
| 现在 | 砍掉代理与 WebSocket 升级路由，改走宿主 HTTP 路由；识别换成百炼；补润色、词表、时长上限 | 火山引擎那套实现仍留在 `src/host/volcengine.ts`，接豆包语音时可以直接参照 |

## 3. 相对上游改了什么

1. **传输层**：WebSocket 升级路由 → 宿主 HTTP 路由 `POST /api/voice-weld/{start,chunk,end,polish}`。
   原因：桌面版页面跑在自定义协议 `dsh-app://app/` 下，`location.host` 是 `app`，前端拼不出可用的 `ws://` 地址，且自定义协议只代理 `fetch`、不转发 WS 升级请求。这也是本插件最关键的架构决定。
2. **识别**：火山引擎 ASR → 百炼 `qwen-audio-3.1-asr-flash-streaming`。
3. **新增**：口语转书面（流式润色）、上下文词表（专有名词纠错）、单次录音时长上限、独立的设置页分区。
4. **移除**：常驻代理进程、端口监听、开机自启。

## 4. 现在有什么功能

**语音输入**
- 流式识别，文字实时进草稿；每轮以「本轮开始时的草稿」为基准追加，不覆盖已有内容
- Esc 取消当前轮，草稿还原到本轮开始前
- 停止后可选润色：把口语整理成书面语（整段替换，0 = 关闭）
- 上下词表（≤400 字）：把「肋弓」「聚宽」这类专有名词喂给识别侧，减少错字
- 单次录音时长上限：1–60 分钟可配（缺省 10），到点自动停止并提示

**稳定性**
- 分三层超时：建连 15 s、空闲看门狗 120 s，**录音本身没有整体超时**——长录音不会被时间杀掉
- 音频按绝对时间轴灌给上游，不靠「发一帧 sleep 100 ms」累加，避免长录音越来越滞后
- 识别侧掉线/超时不再静默：前端收工、保留已识别文字、提示「识别已中断」
- 孤儿会话自动回收（识别完 5 分钟 / 仍在录 30 分钟）

**界面**
- 麦克风按钮三态：录音中（显示 mm:ss，剩 30 s 转琥珀色）/ 整理中 / 连麦中
- 设置页「语音输入（百炼）」分区：力度、词表、时长上限

## 5. 还没做 / 后面可以做的

- **接火山引擎或豆包 ASR**：`src/host/volcengine.ts` 里有完整的二进制帧协议实现，改一个 `AsrStream` 适配层即可
- **语音对话（ASR → LLM → TTS）**：老的 WS 版控制器与 pipeline hook 还在（见 §8），接回来就是完整语音对话
- **润色逐字替换**：目前是停止后整段替换，上屏时会跳一下；把 `/polish` 的 `onChunk` 接回前端即可
- **静音自动断句**：刻意没做（说话中间停顿多）；真要做应该做成开关
- **唤醒词**：代码里有一份没启用的实现

## 6. 代码结构

```
src/index.ts                宿主入口：读 API Key、注入 webServer、注册路由
src/host/voice-http.ts      四个 HTTP 路由 + mergeText 去重
src/host/dashscope.ts       百炼流式 ASR（WS）+ qwen-flash 润色（HTTP 流式）
src/host/asr-utterance.ts   单句话筒：输入队列 → 等 final → 结束/取消
src/host/bounded-queue.ts   有界队列（背压）
src/client/apply.ts         客户端入口：注册两个槽位 + locale
src/client/VoiceHttpController.ts  录音控制（AudioWorklet → 16 kHz Int16 → 分片 POST）
src/client/VoiceInputButton.tsx    麦克风按钮
src/client/VoiceSettingsSection.tsx 设置页分区
```

数据流：

```
麦克风 → AudioWorklet(2048 帧) → 16 kHz / Int16 → 每 200 ms 一片 POST /chunk
       → 宿主 dashscope WS → partial / final 文本
       → 前端写回草稿（本轮基准 + 最新文本，追加）
停止 → POST /end → 收齐 final →（可选）POST /polish → 覆盖成书面语
```

## 7. 开发与构建

```powershell
node build.mjs        # esbuild 产出 lib/index.js + lib/client.js
npx vitest run _test  # 单元测试，不需要麦克风、不出网
node _boot2.mjs lib\client.js   # 手工自检：真的把组件渲染成 HTML
```

改代码前必须知道的几条：

- **`build.mjs` 里客户端那段必须是 `jsx: 'automatic'`（配 `jsxDev: false`）**。esbuild 默认 classic transform 会编成 `React.createElement`，而组件只 `import { useState } from 'react'`，作用域里没有 `React` 标识符 → 渲染即 `ReferenceError: React is not defined`，**界面一个字都不报，话筒按钮和设置分区一起消失**。`_test/client-boot.test.ts` 就是这条的护栏。
- **改了宿主侧**（`src/index.ts`、`src/host/*`）：必须整进程退出 DSH 再开。`Ctrl+R` 只重载前端，`/api` 路由不更新。
- **只改客户端**：`node build.mjs` 后刷新页面即可。
- **`npm pack` 不跑 `prepublishOnly`**，打包前自己记得 build，否则打进去的是旧 `lib/`。
- **句末判定**：`payload.output.sentence.sentence_end === true`。
- **`mergeText()`**：partial 与 final 有重叠，按 2–6 字最长公共前缀去重（治「我我们」「的的」）。
- **必须等 `task-started` 才能发音频**（最多等 3 s），发早了上游直接断连。
- 从外部 `curl` 请求 `/api/voice-weld/start` 一定返回 `401`：所有 `/api` 路由先过宿主鉴权，**401 不代表路由坏了**。

## 8. 保留的老代码（不是活路径）

fork 时保留了上游的 WebSocket 版实现和火山引擎协议，供将来扩展参考：

| 文件 | 是什么 | 用途 |
|---|---|---|
| `src/host/volcengine.ts` | 火山引擎 ASR/TTS 完整协议（二进制帧 + gzip + `X-Api-Key`） | 接豆包/火山语音时照改 |
| `src/client/VoiceController.ts` | WS 版录音控制器（含 TTS 播放、打断） | 做「语音对话」才需要 |
| `src/host/voice-server.ts` | 老的 `/voice` WS 升级路由 | 同上 |
| `src/client/usePipelineVoice.ts` | ASR → LLM → TTS 的 pipeline hook | 同上 |
| `src/host/voice-trust.ts` | WS 版的同源 / loopback 校验 | 走 HTTP 后不需要 |
| `src/client/wake-word.ts` | 唤醒词（未启用） | 未启用 |

## 9. 已知限制

- 润色是整段替换，上屏会跳一下
- 纯网络抖动（超时但会话还在）只会丢那一小段，前端不弹窗——避免每 200 ms 报一次错
- 时长上限只管单次录音，不跨轮记忆
- `lib/types/*.d.ts` 是旧 tsc 产物，运行时不用它们

## 10. 版本记录

| 版本 | 改动 |
|---|---|
| 0.1.0 | 从 `dsh-voice-live` fork 改造成百炼版：宿主 HTTP 路由 + 流式识别 + 润色 + 词表 |
| 0.2.0 | 长录音被杀修复（60 s 整体超时 → 建连 15 s + 空闲 120 s）；灌帧改绝对时间轴；chunk/end 返回 `ended`/`error`/`dropped`；各路由加超时兜底；录音时长上限可配；按钮三态；会话 GC |
| 0.2.1 | 修 0.2.0 的 JSX 编译模式回归（`React is not defined`）；新增 `_test/client-boot.test.ts` 护栏与 `_boot2.mjs` 自检脚本 |

## 许可

见 [LICENSE](LICENSE)。
