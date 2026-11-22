try {
window.__ModuleLoader__.load({
  id: "dsh-voice-weld",
  factory: (require) => {
    try {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/VoiceInputButton.tsx
var import_react = require("react");

// src/client/VoiceHttpController.ts
var WORKLET = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(0); }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const merged = new Float32Array(this.buf.length + input[0].length);
      merged.set(this.buf, 0); merged.set(input[0], this.buf.length);
      if (merged.length >= 2048) {
        this.port.postMessage(merged.slice(0, 2048));
        this.buf = merged.slice(2048);
      } else { this.buf = merged; }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;
var API = "/api/voice-weld";
var FLUSH_MS = 200;
var CHUNK_TIMEOUT_MS = 15e3;
var END_TIMEOUT_MS = 3e4;
var POLISH_TIMEOUT_MS = 3e4;
var KEY_MAX_MINUTES = "dsh-voice-max-minutes";
var DEFAULT_MAX_MINUTES = 10;
var MIN_MAX_MINUTES = 1;
var MAX_MAX_MINUTES = 60;
function clampMaxMinutes(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_MINUTES;
  return Math.min(MAX_MAX_MINUTES, Math.max(MIN_MAX_MINUTES, Math.round(value)));
}
function readMaxRecordMs() {
  const raw = Number(localStorage.getItem(KEY_MAX_MINUTES) ?? String(DEFAULT_MAX_MINUTES));
  return clampMaxMinutes(raw) * 6e4;
}
function timeoutSignal(ms) {
  const native = AbortSignal.timeout;
  if (typeof native === "function") return native.call(AbortSignal, ms);
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, ms);
  return controller.signal;
}
function currentDraft() {
  const textarea = document.querySelector("textarea");
  if (textarea !== null) return textarea.value;
  const editable = document.querySelector('[contenteditable="true"]');
  return editable instanceof HTMLElement ? editable.innerText : "";
}
var VoiceHttpController = class {
  constructor(cb) {
    this.cb = cb;
  }
  state = "idle";
  stream = null;
  audio = null;
  node = null;
  sessionId = "";
  base = "";
  pending = [];
  pendingBytes = 0;
  inflight = false;
  flushTimer = null;
  tickTimer = null;
  startedAt = 0;
  maxMs = DEFAULT_MAX_MINUTES * 6e4;
  stopped = false;
  get isActive() {
    return this.state === "acquiring" || this.state === "listening" || this.state === "thinking";
  }
  get elapsedMs() {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }
  get limitMs() {
    return this.maxMs;
  }
  level() {
    const raw = Number(localStorage.getItem("dsh-voice-polish-level") ?? "2");
    return Number.isFinite(raw) ? Math.min(3, Math.max(0, Math.round(raw))) : 2;
  }
  async start() {
    if (this.isActive) return;
    this.stopped = false;
    this.base = currentDraft();
    this.pending = [];
    this.pendingBytes = 0;
    this.maxMs = readMaxRecordMs();
    this.setState("acquiring");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      this.stream = stream;
      const audio = new AudioContext({ sampleRate: 16e3 });
      this.audio = audio;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try {
        await audio.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const source = audio.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(audio, "pcm-processor");
      node.port.onmessage = (ev) => this.onFrame(ev.data);
      source.connect(node);
      this.node = node;
      const level = this.level();
      const res = await fetch(`${API}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context: (localStorage.getItem("dsh-voice-context") ?? "").slice(0, 400),
          polish: level > 0,
          level
        })
      });
      const data = await res.json();
      if (this.stopped) {
        this.release();
        return;
      }
      if (!res.ok || typeof data.id !== "string") {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      this.sessionId = data.id;
      this.startedAt = Date.now();
      this.setState("listening");
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_MS);
      this.startTick();
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : "\u65E0\u6CD5\u8FDE\u63A5\u8BED\u97F3\u670D\u52A1");
      this.release();
      this.setState("failed");
    }
  }
  onFrame(frame) {
    if (this.state !== "listening") return;
    if (Date.now() - this.startedAt > this.maxMs) {
      const minutes = Math.max(1, Math.round(this.maxMs / 6e4));
      this.cb.onNotice?.(`\u5DF2\u5F55\u6EE1 ${minutes} \u5206\u949F\uFF08\u5355\u6B21\u4E0A\u9650\uFF09\uFF0C\u81EA\u52A8\u505C\u6B62\u5E76\u6574\u7406`);
      void this.stop();
      return;
    }
    const i16 = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
      i16[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    const bytes = new Uint8Array(i16.buffer);
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    if (this.pendingBytes >= 64e3) void this.flush();
  }
  async flush() {
    if (this.inflight || this.pendingBytes === 0 || this.sessionId === "") return;
    this.inflight = true;
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }
    try {
      const res = await fetch(`${API}/chunk?id=${encodeURIComponent(this.sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
        signal: timeoutSignal(CHUNK_TIMEOUT_MS)
      });
      if (res.status === 404) {
        this.finishRemotely("\u8BC6\u522B\u4F1A\u8BDD\u5DF2\u5931\u6548");
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const partial = typeof data.partial === "string" ? data.partial : "";
      if (partial !== "") this.cb.onText(this.base + partial);
      if (data.ended === true) this.finishRemotely(data.error);
    } catch {
    } finally {
      this.inflight = false;
    }
  }
  /** 识别侧已经结束：收工、保留已识别文字、回到 idle，并说明原因。 */
  finishRemotely(reason) {
    if (this.state !== "listening") return;
    this.sessionId = "";
    this.clearTimer();
    this.stopCapture();
    const detail = (reason ?? "").trim();
    this.cb.onNotice?.(detail === "" ? "\u8BC6\u522B\u8FDE\u63A5\u5DF2\u4E2D\u65AD\uFF0C\u5DF2\u4FDD\u7559\u5DF2\u8BC6\u522B\u7684\u6587\u5B57" : `\u8BC6\u522B\u5DF2\u4E2D\u65AD\uFF1A${detail}\uFF08\u5DF2\u4FDD\u7559\u5DF2\u8BC6\u522B\u7684\u6587\u5B57\uFF09`);
    this.setState("idle");
  }
  async stop() {
    if (this.state !== "listening") return;
    this.setState("thinking");
    this.clearTimer();
    await this.flush();
    this.stopCapture();
    const level = this.level();
    try {
      const res = await fetch(`${API}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: this.sessionId }),
        signal: timeoutSignal(END_TIMEOUT_MS)
      });
      this.sessionId = "";
      if (!res.ok) {
        const data2 = await res.json().catch(() => ({}));
        this.cb.onError(data2.error ?? `\u7ED3\u675F\u8BC6\u522B\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
        return;
      }
      const data = await res.json();
      const final = (data.final ?? "").trim();
      if (final === "") {
        this.cb.onError(data.error === void 0 || data.error === "" ? "\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3" : data.error);
        return;
      }
      this.cb.onText(this.base + final);
      if (level > 0) {
        try {
          const polished = await fetch(`${API}/polish`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: final, level }),
            signal: timeoutSignal(POLISH_TIMEOUT_MS)
          });
          const p = await polished.json();
          if (typeof p.text === "string" && p.text.trim() !== "") {
            this.cb.onText(this.base + p.text.trim());
          } else if (p.error !== void 0 && p.error !== "") {
            this.cb.onNotice?.(`\u6574\u7406\u672A\u5B8C\u6210\uFF1A${p.error}\uFF08\u4FDD\u7559\u539F\u6587\uFF09`);
          }
        } catch {
          this.cb.onNotice?.("\u6574\u7406\u8D85\u65F6\uFF0C\u5DF2\u4FDD\u7559\u539F\u59CB\u8BC6\u522B\u7ED3\u679C");
        }
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      this.cb.onError(aborted ? "\u7ED3\u675F\u8BC6\u522B\u8D85\u65F6\uFF0C\u5DF2\u4FDD\u7559\u5DF2\u8BC6\u522B\u7684\u6587\u5B57" : err instanceof Error ? err.message : "\u8BED\u97F3\u670D\u52A1\u5F02\u5E38");
    } finally {
      this.sessionId = "";
      this.base = "";
      this.setState("idle");
    }
  }
  /** 取消：停止采集、丢弃本轮，草稿恢复为开始前的样子。 */
  cancel() {
    this.stopped = true;
    this.clearTimer();
    this.stopCapture();
    if (this.sessionId !== "") {
      void fetch(`${API}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: this.sessionId })
      }).catch(() => {
      });
      this.sessionId = "";
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.setState("idle");
  }
  startTick() {
    this.stopTick();
    this.cb.onTick?.(0, this.maxMs);
    this.tickTimer = setInterval(() => {
      if (this.state !== "listening") {
        this.stopTick();
        return;
      }
      this.cb.onTick?.(this.elapsedMs, this.maxMs);
    }, 1e3);
  }
  stopTick() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
  clearTimer() {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopTick();
  }
  stopCapture() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;
    void this.audio?.close();
    this.audio = null;
  }
  release() {
    this.clearTimer();
    this.stopCapture();
    this.sessionId = "";
  }
  setState(state) {
    if (this.state !== state) {
      this.state = state;
      if (state !== "listening") this.stopTick();
      this.cb.onState(state);
    }
  }
};

// src/client/VoiceInputButton.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var ACTIVE = /* @__PURE__ */ new Set(["acquiring", "listening", "thinking"]);
var RED = "#ef4444";
var BLUE = "#3b82f6";
var AMBER = "#f59e0b";
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function VoiceInputButton({ inputActions }) {
  const [state, setState] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)(null);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [elapsed, setElapsed] = (0, import_react.useState)(0);
  const [limitMs, setLimitMs] = (0, import_react.useState)(DEFAULT_MAX_MINUTES * 6e4);
  const controllerRef = (0, import_react.useRef)(null);
  const controller = () => {
    if (controllerRef.current === null) {
      controllerRef.current = new VoiceHttpController({
        onState: setState,
        onText: (text) => {
          inputActions.setDraft(text);
        },
        onError: (message2) => {
          setError(message2);
        },
        onNotice: (message2) => {
          setNotice({ text: message2, at: Date.now() });
        },
        onTick: (ms, max) => {
          setElapsed(ms);
          setLimitMs(max);
        }
      });
    }
    return controllerRef.current;
  };
  (0, import_react.useEffect)(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, 6e3);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  (0, import_react.useEffect)(() => {
    if (error === null) return;
    const timer = setTimeout(() => {
      setError(null);
    }, 6e3);
    return () => {
      clearTimeout(timer);
    };
  }, [error]);
  (0, import_react.useEffect)(() => {
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      const current = controllerRef.current;
      if (current?.isActive === true) {
        ev.preventDefault();
        current.cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      controllerRef.current?.cancel();
    };
  }, []);
  const active = ACTIVE.has(state);
  const listening = state === "listening";
  const thinking = state === "thinking";
  const acquiring = state === "acquiring";
  const remaining = limitMs - elapsed;
  const low = listening && remaining <= 3e4;
  const accent = thinking ? BLUE : RED;
  const label = error ?? (listening ? `\u505C\u6B62\u5E76\u6574\u7406 \xB7 \u5DF2\u5F55 ${clock(elapsed)}\uFF08Esc \u53D6\u6D88\uFF09` : thinking ? "\u6B63\u5728\u6574\u7406\u2026" : acquiring ? "\u6B63\u5728\u8FDE\u63A5\u9EA6\u514B\u98CE\u2026" : `\u8BED\u97F3\u8F93\u5165\uFF08\u5355\u6B21\u6700\u957F ${Math.round(limitMs / 6e4)} \u5206\u949F\uFF09`);
  const message = error ?? notice?.text ?? null;
  const messageColor = error !== null ? "#e5484d" : "#0ea5e9";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }, children: [
    message !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        style: {
          position: "absolute",
          bottom: "100%",
          left: 0,
          maxWidth: 420,
          whiteSpace: "normal",
          fontSize: 11,
          lineHeight: 1.35,
          color: messageColor,
          background: "rgba(0,0,0,0.75)",
          padding: "2px 6px",
          borderRadius: 4
        },
        role: error !== null ? "alert" : "status",
        children: message
      }
    ),
    active && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        "aria-hidden": true,
        style: {
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          color: low ? AMBER : thinking ? BLUE : RED,
          opacity: active ? 1 : 0
        },
        children: thinking ? "\u6574\u7406\u4E2D\u2026" : clock(elapsed)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        title: label,
        "aria-label": label,
        "aria-pressed": listening || acquiring,
        "aria-busy": thinking,
        disabled: thinking,
        onClick: () => {
          setError(null);
          setNotice(null);
          const c = controller();
          if (c.isActive) void c.stop();
          else void c.start();
        },
        style: {
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 8,
          border: "none",
          cursor: thinking ? "default" : "pointer",
          background: active ? thinking ? "rgba(59,130,246,0.16)" : "rgba(239,68,68,0.16)" : "transparent",
          color: active ? accent : "currentColor",
          opacity: acquiring ? 0.7 : 1
        },
        children: [
          thinking ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "8", cy: "8", r: "6", fill: "none", stroke: "currentColor", strokeOpacity: "0.25", strokeWidth: "2" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 2a6 6 0 0 1 6 6", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "animateTransform",
              {
                attributeName: "transform",
                type: "rotate",
                from: "0 8 8",
                to: "360 8 8",
                dur: "0.9s",
                repeatCount: "indefinite"
              }
            ) })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 1a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 1 1-5 0v-3A2.5 2.5 0 0 1 8 1Z", fill: "currentColor" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3.5 7.5a4.5 4.5 0 0 0 9 0h-1.5a3 3 0 0 1-6 0h-1.5Z", fill: "currentColor" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 11.75a4.25 4.25 0 0 1-4.25-4.25H2.25A5.75 5.75 0 0 0 7.25 13.2V15h1.5v-1.8a5.75 5.75 0 0 0 5-5.7h-1.5A4.25 4.25 0 0 1 8 11.75Z", fill: "currentColor" })
          ] }),
          listening && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "svg",
            {
              "aria-hidden": true,
              viewBox: "0 0 6 6",
              width: "6",
              height: "6",
              style: { position: "absolute", top: 4, right: 4 },
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "3", cy: "3", r: "3", fill: RED, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("animate", { attributeName: "opacity", values: "1;0.25;1", dur: "1.4s", repeatCount: "indefinite" }) })
            }
          )
        ]
      }
    )
  ] });
}

// src/client/VoiceSettingsSection.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var KEY_LEVEL = "dsh-voice-polish-level";
var KEY_LEGACY = "dsh-voice-polish";
var KEY_CONTEXT = "dsh-voice-context";
var LEVELS = [
  { value: 0, name: "\u4E0D\u6539\u5199", desc: "\u8BC6\u522B\u5230\u4EC0\u4E48\u5C31\u5199\u4EC0\u4E48\uFF0C\u53EA\u8865\u4E0D\u52A0\u3002" },
  { value: 1, name: "\u8F7B\u5EA6", desc: "\u53EA\u8865\u6807\u70B9\u3001\u89C4\u8303\u6570\u5B57\u5355\u4F4D\uFF0C\u4E0D\u5220\u8BCD\u3001\u4E0D\u8C03\u8BED\u5E8F\u3002" },
  { value: 2, name: "\u6807\u51C6", desc: "\u53BB\u53E3\u7656\u3001\u91CD\u590D\u3001\u81EA\u6211\u7EA0\u6B63\uFF0C\u8865\u6807\u70B9\u5E76\u5206\u53E5\u3002" },
  { value: 3, name: "\u8F83\u5F3A", desc: "\u53EF\u5408\u5E76\u88AB\u505C\u987F\u5207\u788E\u7684\u534A\u53E5\u3001\u5FAE\u8C03\u8BED\u5E8F\uFF0C\u4F46\u4E0D\u589E\u5220\u4FE1\u606F\u3002" }
];
var MINUTE_CHOICES = [3, 5, 10, 15, 20, 30, 45, 60];
function readLevel() {
  const stored = localStorage.getItem(KEY_LEVEL);
  if (stored !== null) {
    const value = Number(stored);
    if (Number.isFinite(value)) return Math.min(3, Math.max(0, Math.round(value)));
  }
  return localStorage.getItem(KEY_LEGACY) === "0" ? 0 : 2;
}
function readContext() {
  return localStorage.getItem(KEY_CONTEXT) ?? "";
}
function readMaxMinutes() {
  const stored = localStorage.getItem(KEY_MAX_MINUTES);
  if (stored === null) return DEFAULT_MAX_MINUTES;
  return clampMaxMinutes(Number(stored));
}
function VoiceSettingsSection(_props) {
  const [level, setLevel] = (0, import_react2.useState)(readLevel);
  const [context, setContext] = (0, import_react2.useState)(readContext);
  const [maxMinutes, setMaxMinutes] = (0, import_react2.useState)(readMaxMinutes);
  const [saved, setSaved] = (0, import_react2.useState)("idle");
  const flashSaved = () => {
    setSaved("ok");
    setTimeout(() => {
      setSaved("idle");
    }, 1200);
  };
  const changeLevel = (value) => {
    setLevel(value);
    localStorage.setItem(KEY_LEVEL, String(value));
    flashSaved();
  };
  const changeMinutes = (value) => {
    const minutes = clampMaxMinutes(value);
    setMaxMinutes(minutes);
    localStorage.setItem(KEY_MAX_MINUTES, String(minutes));
    flashSaved();
  };
  const save = () => {
    localStorage.setItem(KEY_CONTEXT, context.slice(0, 400));
    localStorage.setItem(KEY_LEVEL, String(level));
    localStorage.setItem(KEY_MAX_MINUTES, String(clampMaxMinutes(maxMinutes)));
    flashSaved();
  };
  const row = { display: "flex", gap: 8, alignItems: "center", marginBottom: 10 };
  const hint = { fontSize: 12, opacity: 0.65, lineHeight: 1.6, margin: 0 };
  const current = LEVELS[level] ?? LEVELS[2];
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: { display: "flex", flexDirection: "column", gap: 12 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: { margin: "0 0 4px", fontSize: 14 }, children: "\u8BED\u97F3\u8F93\u5165\uFF08\u767E\u70BC\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: hint, children: "\u6D41\u5F0F\u8BC6\u522B\uFF1A\u8FB9\u8BF4\u8FB9\u51FA\u5B57\uFF1B\u505C\u6B62\u5F55\u97F3\u540E\u6309\u4E0B\u9762\u7684\u529B\u5EA6\u505A\u4E00\u6B21\u300C\u53E3\u8BED\u8F6C\u4E66\u9762\u300D\u3002 \u5BC6\u94A5\u7531 DSH \u4E3B\u8FDB\u7A0B\u8BFB\u53D6\uFF0C\u4E0D\u9700\u8981\u5728\u8FD9\u91CC\u586B\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { fontSize: 13 }, children: [
        "\u6574\u7406\u529B\u5EA6\uFF1A",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: current.name })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          type: "range",
          min: 0,
          max: 3,
          step: 1,
          value: level,
          onChange: (e) => {
            changeLevel(Number(e.target.value));
          },
          style: { width: "100%" }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.6 }, children: LEVELS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: item.name }, item.value)) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: hint, children: current.desc })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { fontSize: 13 }, children: [
        "\u5355\u6B21\u5F55\u97F3\u65F6\u957F\u4E0A\u9650\uFF1A",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("strong", { children: [
          maxMinutes,
          " \u5206\u949F"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 }, children: MINUTE_CHOICES.map((minutes) => {
        const selected = minutes === maxMinutes;
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            onClick: () => {
              changeMinutes(minutes);
            },
            style: {
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 12,
              cursor: "pointer",
              border: `1px solid ${selected ? "rgba(59,130,246,0.9)" : "rgba(128,128,128,0.35)"}`,
              background: selected ? "rgba(59,130,246,0.16)" : "transparent",
              color: "inherit"
            },
            children: minutes
          },
          minutes
        );
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: hint, children: "\u70B9\u9EA6\u514B\u98CE\u5F00\u59CB\uFF0C\u5230\u70B9\u4F1A\u81EA\u52A8\u505C\u6B62\u5E76\u6574\u7406\uFF08\u4F1A\u6709\u63D0\u793A\uFF0C\u4E0D\u4F1A\u6084\u65E0\u58F0\u606F\u5730\u65AD\uFF09\u3002 \u60F3\u66F4\u4E45\u5C31\u9009\u5927\u4E00\u70B9\uFF0C\u6700\u957F 60 \u5206\u949F\uFF1B\u8BC6\u522B\u662F\u6D41\u5F0F\u7684\uFF0C\u4E2D\u9014\u4E00\u76F4\u51FA\u5B57\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 13 }, children: "\u8BCD\u8868 / \u4E0A\u4E0B\u6587\uFF08\u6BCF\u884C\u6216\u7A7A\u683C\u5206\u9694\uFF0C\u6700\u591A 400 \u5B57\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          value: context,
          onChange: (e) => {
            setContext(e.target.value);
          },
          rows: 4,
          placeholder: "\u4F8B\uFF1A\u808B\u5F13 \u8179\u8154\u79EF\u6DB2 \u813E\u810F \u63A2\u67E5 \u6B62\u8840 \u7F1D\u5408",
          style: {
            width: "100%",
            resize: "vertical",
            fontFamily: "inherit",
            fontSize: 13,
            padding: 8,
            borderRadius: 8,
            border: "1px solid rgba(128,128,128,0.35)",
            background: "transparent",
            color: "inherit"
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: hint, children: [
        context.length,
        "/400 \xB7 \u8BF4\u8BDD\u65F6\u82E5\u542B\u8FD9\u4E9B\u8BCD\uFF0C\u8BC6\u522B\u4F1A\u4F18\u5148\u9009\u5B83\u4EEC\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: row, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", onClick: save, style: { padding: "6px 14px", borderRadius: 8, cursor: "pointer" }, children: "\u4FDD\u5B58\u8BCD\u8868" }),
      saved === "ok" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "#22c55e" }, children: "\u5DF2\u4FDD\u5B58\uFF0C\u4E0B\u4E00\u6B21\u5F55\u97F3\u751F\u6548" })
    ] })
  ] });
}

// src/client/locales.ts
var NS = "voice";
var zh = {
  "voice.nav": "\u8BED\u97F3\u4EA4\u4E92",
  "voice.heading": "\u8BED\u97F3\u4EA4\u4E92",
  "voice.provider": "\u670D\u52A1\u5546",
  "voice.apiKey": "API Key",
  "voice.apiKeyPlaceholder": "\u7C98\u8D34\u4F60\u7684 API Key",
  "voice.voice": "\u97F3\u8272",
  "voice.hint": "\u97F3\u8272\u7528\u4E8E\u6717\u8BFB\u56DE\u7B54\uFF1BAPI Key \u7528\u4E8E\u6240\u9009\u670D\u52A1\u5546\u7684\u8BED\u97F3\u8BC6\u522B\u4E0E\u5408\u6210\u3002",
  "voice.preview": "\u8BD5\u542C",
  "voice.mic": "\u5B9E\u65F6\u8BED\u97F3",
  "voice.micActive": "\u5B9E\u65F6\u8BED\u97F3\u5BF9\u8BDD\u4E2D\uFF08\u70B9\u51FB\u7ED3\u675F\uFF09",
  "voice.backendKeyHint": "API Key \u7531\u540E\u7AEF\u63D0\u4F9B\uFF08~/.dsh/api-key.env \u4E2D\u7684 VOLCENGINE_API_KEY\uFF09\uFF0C\u65E0\u9700\u5728\u6B64\u586B\u5199\u3002",
  "voice.replyFirst": "\u5148\u54CD\u5E94\u540E\u601D\u8003\uFF08\u8BF4\u5B8C\u5148\u56DE\u5E94\u4E00\u53E5\uFF0C\u518D\u8BA9\u52A9\u624B\u53BB\u67E5\uFF09",
  "voice.aecProbe": "\u56DE\u58F0\u6D88\u9664\u68C0\u6D4B\uFF08\u53D7\u63A7\u6D4B\u8BD5\uFF1A\u626C\u58F0\u5668/\u8033\u673A\u5BF9\u6BD4\u7528\uFF09",
  "voice.aecProbeAction": "\u68C0\u6D4B",
  "voice.aecOn": "\u6D4F\u89C8\u5668\u5DF2\u5BF9\u9EA6\u514B\u98CE\u5E94\u7528\u56DE\u58F0\u6D88\u9664\uFF08AEC \u751F\u6548\uFF09",
  "voice.aecOff": "\u6D4F\u89C8\u5668\u672A\u5E94\u7528\u56DE\u58F0\u6D88\u9664\uFF08AEC \u672A\u751F\u6548\uFF09",
  "voice.aecUnavailable": "\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE\uFF08\u68C0\u67E5\u6D4F\u89C8\u5668\u6743\u9650\uFF09",
  "voice.wakeEnable": "\u8BED\u97F3\u5524\u9192\uFF08\u8BF4\u5524\u9192\u8BCD\u81EA\u52A8\u5F00\u59CB\u5BF9\u8BDD\uFF0C\u4F1A\u6301\u7EED\u5360\u7528\u9EA6\u514B\u98CE\uFF09",
  "voice.wakeWord": "\u5524\u9192\u8BCD",
  "voice.wakeProbe": "\u68C0\u6D4B\u5524\u9192\u53EF\u7528\u6027",
  "voice.wakeProbeBusy": "\u68C0\u6D4B\u4E2D\u2026",
  "voice.wakeOk": "\u6D4F\u89C8\u5668\u8BED\u97F3\u8BC6\u522B\u53EF\u7528",
  "voice.wakeUnsupported": "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Speech \u8BED\u97F3\u8BC6\u522B\uFF08\u5EFA\u8BAE Chrome \u6216 Safari\uFF09",
  "voice.wakeUnavailable": "\u8BED\u97F3\u8BC6\u522B\u65E0\u6CD5\u542F\u52A8",
  "voice.wakeError": "\u8BED\u97F3\u8BC6\u522B\u51FA\u9519",
  "voice.wakeNetworkHint": "Chrome \u7684\u8BED\u97F3\u8BC6\u522B\u4F9D\u8D56\u53EF\u8BBF\u95EE\u7684 Google \u8BED\u97F3\u670D\u52A1\uFF1B\u5F53\u524D\u7F51\u7EDC\u4E0D\u53EF\u8FBE\u65F6\u65E0\u6CD5\u5524\u9192\u3002"
};
var en = {
  "voice.nav": "Voice",
  "voice.heading": "Voice Interaction",
  "voice.provider": "Provider",
  "voice.apiKey": "API Key",
  "voice.apiKeyPlaceholder": "Paste your API key",
  "voice.voice": "Voice",
  "voice.hint": "The voice reads replies aloud; the API key powers the selected provider's ASR and TTS.",
  "voice.preview": "Preview",
  "voice.mic": "Real-time voice",
  "voice.micActive": "Real-time voice on (click to end)",
  "voice.backendKeyHint": "The API key is provided by the backend (VOLCENGINE_API_KEY in ~/.dsh/api-key.env).",
  "voice.replyFirst": "Reply first, then think (acknowledge the request before the assistant goes to look it up)",
  "voice.aecProbe": "Echo-cancellation probe (controlled test: speaker vs headphone)",
  "voice.aecProbeAction": "Probe",
  "voice.aecOn": "The browser applied AEC to the mic track",
  "voice.aecOff": "The browser did not apply AEC to the mic track",
  "voice.aecUnavailable": "Mic unavailable (check browser permission)",
  "voice.wakeEnable": "Wake word (speak the keyword to start; keeps the mic on)",
  "voice.wakeWord": "Wake word",
  "voice.wakeProbe": "Probe wake availability",
  "voice.wakeProbeBusy": "Probing\u2026",
  "voice.wakeOk": "Browser speech recognition is available",
  "voice.wakeUnsupported": "This browser does not support the Web Speech API (Chrome or Safari recommended)",
  "voice.wakeUnavailable": "Speech recognition failed to start",
  "voice.wakeError": "Speech recognition error",
  "voice.wakeNetworkHint": "Chrome speech recognition relies on the Google speech service; it cannot wake when that service is unreachable."
};

// src/client/apply.ts
var inject = ["slots", "locale"];
function guard(run) {
  return () => {
    try {
      return run();
    } catch (error) {
      console.error("[dsh-voice-weld] voice UI registration failed; other plugins keep running", error);
      return () => {
      };
    }
  };
}
function apply(ctx) {
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-voice-weld: dictionaries");
    const t = ctx.locale.bind(NS);
    ctx.slots.inject("conversation.input.right", guard(() => ctx.slots.register({
      name: "conversation.input.right",
      id: "voice-weld",
      order: 30,
      locale: NS,
      inject: () => ({ t })
    }, VoiceInputButton)));
    ctx.slots.inject("settings.section", guard(() => ctx.slots.register({
      name: "settings.section",
      id: "voice-weld",
      order: 100,
      label: () => t("voice.nav"),
      locale: NS
    }, VoiceSettingsSection)));
  } catch (error) {
    console.error("[dsh-voice-weld] voice UI failed to start; other plugins keep running", error);
  }
}

    return module.exports;
    } catch (error) {
      console.error("[dsh-voice-live] client module failed; the rest of the UI keeps running", error);
      return { apply() {}, inject: [] };
    }
  }
});
} catch (error) {
  console.error("[dsh-voice-live] client registration failed; the rest of the UI keeps running", error);
}
