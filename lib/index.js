// src/index.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/host/voice-http.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/host/dashscope.ts
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
var ASR_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
var CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
var FRAME_BYTES = 3200;
var FRAME_MS = 100;
function contextPayload(context) {
  const text = (context ?? "").trim();
  if (text === "") return {};
  return { context: [{ role: "user", content: [{ type: "input_text", text: text.slice(0, 400) }] }] };
}
async function asrStream(pcmSource, apiKey, onText, options = {}) {
  const {
    model = "qwen-audio-3.1-asr-flash-streaming",
    context,
    signal,
    connectTimeoutMs = 15e3,
    idleTimeoutMs = 12e4
  } = options;
  const taskId = randomUUID();
  const ws = new WebSocket(ASR_URL, {
    headers: { Authorization: `bearer ${apiKey}`, "X-DashScope-DataInspection": "enable" }
  });
  let finished = false;
  let finishing = false;
  let sentFrames = 0;
  let sentBytes = 0;
  let lastActivity = Date.now();
  let wake = null;
  const source = typeof pcmSource === "string" ? (async function* () {
    const { readFile } = await import("node:fs/promises");
    const all = await readFile(pcmSource);
    for (let i = 0; i < all.length; i += FRAME_BYTES) yield all.subarray(i, i + FRAME_BYTES);
  })() : Buffer.isBuffer(pcmSource) ? (async function* () {
    for (let i = 0; i < pcmSource.length; i += FRAME_BYTES) yield pcmSource.subarray(i, i + FRAME_BYTES);
  })() : pcmSource;
  const result = new Promise((resolve, reject) => {
    let connectTimer = null;
    let idleTimer = null;
    const cleanup = () => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer !== null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const bail = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
      }
      reject(err);
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
      }
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    connectTimer = setTimeout(() => {
      bail(new Error(`asr connect timeout after ${connectTimeoutMs} ms`));
    }, connectTimeoutMs);
    if (idleTimeoutMs > 0) {
      idleTimer = setInterval(() => {
        if (finished) return;
        if (Date.now() - lastActivity > idleTimeoutMs) {
          bail(new Error(`asr idle timeout after ${idleTimeoutMs} ms`));
        }
      }, Math.min(5e3, Math.max(1e3, Math.floor(idleTimeoutMs / 4))));
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model,
          parameters: { format: "pcm", sample_rate: 16e3, language_hints: ["zh", "en"] },
          input: contextPayload(context)
        }
      }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        const parsed = JSON.parse(data.toString());
        if (typeof parsed !== "object" || parsed === null) return;
        event = parsed;
      } catch {
        return;
      }
      const header = event.header ?? {};
      const action = header.event;
      lastActivity = Date.now();
      if (action === "task-started") {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        wake?.();
      } else if (action === "result-generated") {
        const payload = event.payload ?? {};
        const output = payload.output ?? {};
        const sentence = output.sentence;
        if (sentence && typeof sentence.text === "string") {
          const text = sentence.text.trim();
          if (text !== "") onText({ text, is_final: sentence.sentence_end === true });
        }
      } else if (action === "task-finished") {
        finished = true;
        cleanup();
        try {
          ws.close();
        } catch {
        }
        resolve();
      } else if (action === "task-failed") {
        const payload = event.payload ?? {};
        const code = String(payload.error_code ?? header.error_code ?? "");
        const msg = String(payload.message ?? header.error_message ?? "asr task failed");
        bail(new Error(code === "" ? msg : `${msg} (${code})`));
      }
    });
    ws.on("error", (err) => {
      bail(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", (code, reason) => {
      if (finished) return;
      if (finishing) {
        finished = true;
        cleanup();
        resolve();
        return;
      }
      const why = reason?.toString().slice(0, 200) ?? "";
      bail(new Error(`asr socket closed (code ${code}${why === "" ? "" : `: ${why}`})`));
    });
  });
  await new Promise((resolve) => {
    wake = resolve;
    void result.catch(() => resolve());
    setTimeout(resolve, 3e3);
  });
  wake = null;
  if (finished) {
    await result.catch(() => {
    });
    return;
  }
  const paceStart = Date.now();
  for await (const chunk of source) {
    if (finished) break;
    if (chunk.length === 0) continue;
    try {
      ws.send(chunk);
    } catch {
      break;
    }
    sentFrames += 1;
    sentBytes += chunk.length;
    lastActivity = Date.now();
    const wait = paceStart + sentFrames * FRAME_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  if (!finished && ws.readyState === WebSocket.OPEN) {
    finishing = true;
    ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
  }
  await result;
  void sentBytes;
}
function polishRules(level) {
  const common = [
    "\u4F60\u662F\u8BED\u97F3\u8F93\u5165\u7684\u201C\u53E3\u8BED\u8F6C\u4E66\u9762\u201D\u5904\u7406\u5668\uFF0C\u53EA\u505A\u6574\u7406\uFF0C\u4E0D\u6539\u5199\u7ACB\u573A\u3002",
    "\u4FDD\u7559\u4E13\u4E1A\u672F\u8BED\uFF08\u5C24\u5176\u662F\u533B\u5B66\u540D\u8BCD\uFF09\u539F\u6837\uFF0C\u4E0D\u8981\u66FF\u6362\u6210\u540C\u4E49\u8BCD\uFF1B",
    "\u4E0D\u8981\u65B0\u589E\u539F\u6587\u6CA1\u6709\u7684\u4FE1\u606F\uFF0C\u4E0D\u8981\u89E3\u91CA\uFF0C\u4E0D\u8981\u52A0\u5F15\u53F7\u6216\u524D\u540E\u7F00\uFF1B",
    "\u53EA\u8F93\u51FA\u6574\u7406\u540E\u7684\u6B63\u6587\u3002"
  ];
  if (level <= 1) {
    return [
      ...common,
      "\u529B\u5EA6\uFF1A\u6700\u8F7B\u3002\u53EA\u8865\u5168\u6807\u70B9\u3001\u628A\u53E3\u5934\u6570\u5B57/\u5355\u4F4D\u5199\u6210\u89C4\u8303\u5199\u6CD5\uFF1B",
      "\u4E0D\u8981\u5220\u9664\u4EFB\u4F55\u8BCD\u3001\u4E0D\u8981\u8C03\u6574\u8BED\u5E8F\u3001\u4E0D\u8981\u5408\u5E76\u53E5\u5B50\uFF0C\u53E3\u7656\u4E0E\u91CD\u590D\u539F\u6837\u4FDD\u7559\u3002"
    ];
  }
  if (level >= 3) {
    return [
      ...common,
      "\u529B\u5EA6\uFF1A\u8F83\u5F3A\u3002\u5220\u9664\u53E3\u7656\u3001\u91CD\u590D\u4E0E\u81EA\u6211\u7EA0\u6B63\uFF0C\u8865\u5168\u6807\u70B9\u5E76\u5408\u7406\u5206\u53E5\uFF1B",
      "\u53EF\u4EE5\u5408\u5E76\u88AB\u505C\u987F\u5207\u788E\u7684\u534A\u53E5\u3001\u5FAE\u8C03\u8BED\u5E8F\u8BA9\u4E66\u9762\u8BED\u66F4\u901A\u987A\uFF0C\u4F46\u4E0D\u5F97\u6539\u53D8\u539F\u610F\u6216\u589E\u51CF\u4FE1\u606F\u3002"
    ];
  }
  return [
    ...common,
    "\u529B\u5EA6\uFF1A\u6807\u51C6\u3002\u5220\u9664\u53E3\u7656\u3001\u91CD\u590D\u3001\u81EA\u6211\u7EA0\u6B63\u4E0E\u8BED\u6C14\u8BCD\uFF1B\u8865\u5168\u6807\u70B9\u5E76\u5408\u7406\u5206\u53E5\uFF1B",
    "\u4E0D\u6539\u53D8\u539F\u53E5\u987A\u5E8F\u4E0E\u7528\u8BCD\uFF0C\u9664\u975E\u660E\u663E\u91CD\u590D\u6216\u8BED\u75C5\u3002"
  ];
}
async function polishStream(text, apiKey, onChunk, options = {}) {
  const model = options.model ?? "qwen-flash";
  const level = Math.min(3, Math.max(1, Math.round(options.level ?? 2)));
  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: polishRules(level).join("\n")
        },
        { role: "user", content: text }
      ]
    })
  };
  if (options.signal !== void 0) init.signal = options.signal;
  const res = await fetch(CHAT_URL, init);
  if (!res.ok || res.body === null) {
    const body = await res.text().catch(() => "");
    throw new Error(`polish http ${res.status}: ${body.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data !== "" && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const piece = parsed.choices?.[0]?.delta?.content ?? "";
            if (piece !== "") {
              full += piece;
              onChunk(piece);
            }
          } catch {
          }
        }
      }
      index = buffer.indexOf("\n");
    }
  }
  return full.trim();
}

// src/host/bounded-queue.ts
var BoundedQueue = class {
  // 4 MB ≈ 128 s 的 16 kHz PCM16（32 KB/s）。生产速度是实时的，正常用不满；
  // 只有网络抖动/服务端变慢时才会积压，容量给足可以把「丢音」推迟到很后面。
  constructor(maxBytes = 4 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }
  buf = [];
  waiters = [];
  ended = false;
  aborted = false;
  bytes = 0;
  rejected = 0;
  /** 入队一帧音频；超上限或已结束/取消时返回 false（帧被拒绝，不记入队列）。 */
  push(chunk) {
    if (this.ended || this.aborted || chunk.length === 0) return false;
    if (chunk.length > this.maxBytes || this.bytes + chunk.length > this.maxBytes) {
      this.rejected += chunk.length;
      return false;
    }
    const w = this.waiters.shift();
    if (w !== void 0) {
      w({ value: chunk, done: false });
    } else {
      this.buf.push(chunk);
      this.bytes += chunk.length;
    }
    return true;
  }
  /** 被丢弃的字节数（队列满时静默丢弃，这里记账供上层提示）。 */
  get rejectedBytes() {
    return this.rejected;
  }
  /** 正常结束：剩余帧消费完后迭代器返回 done，调用方据此发 NegativeSeq 收尾等最终结果。 */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.drainWaiters();
  }
  /** 取消：清空队列并结束，调用方据此直接丢弃、不再等结果。 */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.ended = true;
    this.buf = [];
    this.bytes = 0;
    this.drainWaiters();
  }
  get isEnded() {
    return this.ended;
  }
  get isAborted() {
    return this.aborted;
  }
  get size() {
    return this.bytes;
  }
  drainWaiters() {
    let w = this.waiters.shift();
    while (w !== void 0) {
      w({ value: void 0, done: true });
      w = this.waiters.shift();
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.buf.shift();
        if (item !== void 0) {
          this.bytes -= item.length;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.ended) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
};

// src/host/asr-utterance.ts
var AsrUtterance = class {
  constructor(apiKey, id, onFinal, onPartial, onError, onSettled = () => {
  }, context = "") {
    this.apiKey = apiKey;
    this.onFinal = onFinal;
    this.onPartial = onPartial;
    this.onError = onError;
    this.onSettled = onSettled;
    this.context = context;
    this.id = id;
  }
  id;
  queue = new BoundedQueue();
  cancelled = false;
  finished = false;
  abortController = new AbortController();
  /** 启动流式识别（并发 sender/receiver）。 */
  start() {
    void (async () => {
      try {
        await asrStream(this.queue, this.apiKey, (r) => {
          if (this.cancelled) return;
          if (r.is_final) {
            const t = r.text.trim();
            if (t !== "") this.onFinal(t);
          } else {
            const t = r.text.trim();
            if (t !== "") this.onPartial(t);
          }
        }, {
          context: this.context,
          signal: this.abortController.signal
        });
      } catch (e) {
        if (!this.cancelled) this.onError(e);
      } finally {
        this.finished = true;
        this.onSettled();
      }
    })();
  }
  /** 喂一帧音频；已结束/已取消时静默丢弃。 */
  push(pcm) {
    if (this.finished || this.cancelled) return false;
    return this.queue.push(pcm);
  }
  /** 正常停止：结束音频流，等待服务端最终结果（exactly-once）。 */
  end() {
    if (this.finished || this.cancelled) return;
    this.queue.end();
  }
  /** 取消：直接丢弃，不提交最终结果。 */
  cancel() {
    if (this.finished) return;
    this.cancelled = true;
    this.queue.abort();
    this.abortController.abort();
  }
  get isFinished() {
    return this.finished;
  }
  /** 队列满被丢掉的音频字节数；>0 说明网络/服务端跟不上，转写会有缺口。 */
  get droppedBytes() {
    return this.queue.rejectedBytes;
  }
};

// src/host/voice-http.ts
function mergeText(head, piece) {
  if (head === "") return piece;
  if (piece === "") return head;
  const max = Math.min(6, head.length, piece.length);
  for (let size = max; size >= 2; size -= 1) {
    if (head.endsWith(piece.slice(0, size))) return head + piece.slice(size);
  }
  return head + piece;
}
var PREFIX = "/api/voice-weld";
function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
async function readJson(req) {
  try {
    const value = await req.json();
    return value !== null && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function field(body, name) {
  const value = body[name];
  return typeof value === "string" ? value : "";
}
function registerVoiceHttp(ctx, options) {
  const sessions = /* @__PURE__ */ new Map();
  const { apiKey, polishModel = "qwen-flash" } = options;
  const start = async (req) => {
    if (apiKey === "") return json({ error: "missing DASHSCOPE_API_KEY" }, 503);
    const body = await readJson(req);
    const context = field(body, "context").slice(0, 400);
    const wantPolish = body.polish !== false;
    const id = randomUUID2();
    let resolve = () => {
    };
    const done = new Promise((r) => {
      resolve = r;
    });
    const session = {
      id,
      transcript: "",
      partial: "",
      done,
      resolve,
      polish: wantPolish,
      createdAt: Date.now(),
      utt: null
    };
    const full = () => mergeText(session.transcript, session.partial);
    session.utt = new AsrUtterance(
      apiKey,
      id,
      // 一次录音里可以有多个句子：逐句累积，交给 end 汇总。
      (final) => {
        session.transcript = mergeText(session.transcript, final);
        session.partial = "";
      },
      (partial) => {
        session.partial = partial;
      },
      (err) => {
        session.error = err;
        session.resolve(full());
      },
      () => {
        session.resolve(full());
      },
      context
    );
    sessions.set(id, session);
    session.utt.start();
    return json({ id, hasKey: true, polish: wantPolish });
  };
  const chunk = async (req) => {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const session = sessions.get(id);
    if (session === void 0) return json({ error: "unknown session", ended: true }, 404);
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length > 0) session.utt.push(bytes);
    const partial = mergeText(session.transcript, session.partial);
    const dropped = session.utt.droppedBytes;
    if (session.utt.isFinished) {
      return json({ partial, ended: true, error: session.error?.message ?? "", dropped });
    }
    return json({ partial, ended: false, dropped });
  };
  const end = async (req) => {
    const body = await readJson(req);
    const id = field(body, "id");
    const session = sessions.get(id);
    if (session === void 0) return json({ error: "unknown session", final: "", ended: true }, 404);
    session.utt.end();
    const fallback = () => mergeText(session.transcript, session.partial);
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(fallback()), 2e4);
    });
    const final = await Promise.race([session.done, timeout]);
    sessions.delete(id);
    return json({ final, error: session.error?.message ?? "", ended: true, dropped: session.utt.droppedBytes });
  };
  const polish = async (req) => {
    const body = await readJson(req);
    const text = field(body, "text").trim();
    if (text === "") return json({ text: "" });
    if (apiKey === "") return json({ text, error: "missing DASHSCOPE_API_KEY" });
    try {
      const rawLevel = typeof body.level === "number" ? body.level : 2;
      const level = Math.min(3, Math.max(1, Math.round(rawLevel)));
      const out = await polishStream(text, apiKey, () => {
      }, { model: polishModel, level });
      const trimmed = out.trim();
      return json({ text: trimmed === "" ? text : trimmed });
    } catch (err) {
      return json({ text, error: err instanceof Error ? err.message : "polish failed" });
    }
  };
  const routes = [
    { path: `${PREFIX}/start`, methods: ["POST"], requestBody: "buffered", fetch: start },
    { path: `${PREFIX}/chunk`, methods: ["POST"], requestBody: "buffered", fetch: chunk },
    { path: `${PREFIX}/end`, methods: ["POST"], requestBody: "buffered", fetch: end },
    { path: `${PREFIX}/polish`, methods: ["POST"], requestBody: "buffered", fetch: polish }
  ];
  ctx.inject(["connection"], (connCtx) => {
    const connection = connCtx.connection;
    for (const route of routes) {
      connCtx.effect(
        () => connection.fetch.register(route),
        `ui-voice-weld: ${route.path}`
      );
    }
    connCtx.effect(() => {
      const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, session] of sessions) {
          const age = now - session.createdAt;
          if (session.utt.isFinished ? age > 5 * 6e4 : age > 30 * 6e4) {
            if (!session.utt.isFinished) session.utt.cancel();
            sessions.delete(id);
          }
        }
      }, 6e4);
      return () => {
        clearInterval(timer);
      };
    }, "ui-voice-weld: session-gc");
  });
}

// src/index.ts
var inject = ["webServer"];
function readCredential(name) {
  try {
    const file = join(homedir(), ".dsh", ".credentials.yaml");
    const text = readFileSync(file, "utf8");
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m"));
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}
function resolveApiKey() {
  const fromEnv = process.env.DASHSCOPE_API_KEY ?? "";
  return fromEnv !== "" ? fromEnv : readCredential("DASHSCOPE_API_KEY");
}
function apply(ctx) {
  const apiKey = resolveApiKey();
  registerVoiceHttp(ctx, {
    apiKey,
    polishModel: process.env.VOICE_POLISH_MODEL ?? "qwen-flash"
  });
  if (apiKey === "") {
    ctx.logger?.warn?.("[voice-weld] \u672A\u627E\u5230 DASHSCOPE_API_KEY\uFF0C\u8BED\u97F3\u8F93\u5165\u4E0D\u53EF\u7528");
  }
}
export {
  apply,
  inject
};
