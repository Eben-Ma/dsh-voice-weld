/**
 * 桌面端语音控制器：HTTP 传输 + 手动停止。
 *
 * - 采集：AudioWorklet 2048 帧 / 16 kHz 单声道 → Int16；每 ~200 ms 批量 POST。
 * - 识别：POST /api/voice-weld/start → 持续 chunk（响应带最新 partial）→ end 拿 final。
 * - 追加：每轮开始时记住草稿里已有的文字（base），partial/final/润色都写成
 *   `base + 本轮文本`，因此连续说几段不会互相顶掉。
 * - 停止：只由用户点击按钮（或按 Esc 取消）触发，不做静音自动断句。
 * - 润色：0=不改写，1/2/3 三档力度，随请求发给宿主。
 */
const WORKLET = `
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
const API = '/api/voice-weld';
const FLUSH_MS = 200;
const MAX_RECORD_MS = 5 * 60_000;
/** 读当前输入框里的文字（桌面版可能是 textarea 或 contenteditable）。 */
function currentDraft() {
    const textarea = document.querySelector('textarea');
    if (textarea !== null)
        return textarea.value;
    const editable = document.querySelector('[contenteditable="true"]');
    return editable instanceof HTMLElement ? editable.innerText : '';
}
export class VoiceHttpController {
    cb;
    state = 'idle';
    stream = null;
    audio = null;
    node = null;
    sessionId = '';
    base = '';
    pending = [];
    pendingBytes = 0;
    inflight = false;
    flushTimer = null;
    startedAt = 0;
    stopped = false;
    constructor(cb) {
        this.cb = cb;
    }
    get isActive() {
        return this.state === 'acquiring' || this.state === 'listening' || this.state === 'thinking';
    }
    level() {
        const raw = Number(localStorage.getItem('dsh-voice-polish-level') ?? '2');
        return Number.isFinite(raw) ? Math.min(3, Math.max(0, Math.round(raw))) : 2;
    }
    async start() {
        if (this.isActive)
            return;
        this.stopped = false;
        this.base = currentDraft();
        this.pending = [];
        this.pendingBytes = 0;
        this.setState('acquiring');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            });
            this.stream = stream;
            const audio = new AudioContext({ sampleRate: 16000 });
            this.audio = audio;
            const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
            try {
                await audio.audioWorklet.addModule(url);
            }
            finally {
                URL.revokeObjectURL(url);
            }
            const source = audio.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(audio, 'pcm-processor');
            node.port.onmessage = (ev) => this.onFrame(ev.data);
            source.connect(node);
            this.node = node;
            const level = this.level();
            const res = await fetch(`${API}/start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    context: (localStorage.getItem('dsh-voice-context') ?? '').slice(0, 400),
                    polish: level > 0,
                    level,
                }),
            });
            const data = await res.json();
            if (this.stopped) {
                this.release();
                return;
            }
            if (!res.ok || typeof data.id !== 'string') {
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            this.sessionId = data.id;
            this.startedAt = Date.now();
            this.setState('listening');
            this.flushTimer = setInterval(() => { void this.flush(); }, FLUSH_MS);
        }
        catch (err) {
            this.cb.onError(err instanceof Error ? err.message : '无法连接语音服务');
            this.release();
            this.setState('failed');
        }
    }
    onFrame(frame) {
        if (this.state !== 'listening')
            return;
        if (Date.now() - this.startedAt > MAX_RECORD_MS) {
            void this.stop();
            return;
        }
        const i16 = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
            i16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const bytes = new Uint8Array(i16.buffer);
        this.pending.push(bytes);
        this.pendingBytes += bytes.byteLength;
        if (this.pendingBytes >= 64_000)
            void this.flush();
    }
    async flush() {
        if (this.inflight || this.pendingBytes === 0 || this.sessionId === '')
            return;
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
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body,
            });
            if (res.ok) {
                const data = await res.json();
                const partial = typeof data.partial === 'string' ? data.partial : '';
                if (partial !== '')
                    this.cb.onText(this.base + partial);
            }
        }
        catch {
            // 单批失败不致命：继续下一批
        }
        finally {
            this.inflight = false;
        }
    }
    async stop() {
        if (this.state !== 'listening')
            return;
        this.setState('thinking');
        this.clearTimer();
        await this.flush();
        this.stopCapture();
        const level = this.level();
        try {
            const res = await fetch(`${API}/end`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: this.sessionId }),
            });
            const data = await res.json();
            const final = (data.final ?? '').trim();
            this.sessionId = '';
            if (final === '') {
                this.cb.onError(data.error === undefined || data.error === '' ? '没有识别到语音' : data.error);
                this.setState('idle');
                return;
            }
            this.cb.onText(this.base + final);
            if (level > 0) {
                const polished = await fetch(`${API}/polish`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ text: final, level }),
                });
                const p = await polished.json();
                this.cb.onText(this.base + (p.text ?? final).trim());
            }
        }
        catch (err) {
            this.cb.onError(err instanceof Error ? err.message : '语音服务异常');
        }
        finally {
            this.base = '';
            this.setState('idle');
        }
    }
    /** 取消：停止采集、丢弃本轮，草稿恢复为开始前的样子。 */
    cancel() {
        this.stopped = true;
        this.clearTimer();
        this.stopCapture();
        if (this.sessionId !== '') {
            void fetch(`${API}/end`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: this.sessionId }),
            }).catch(() => { });
            this.sessionId = '';
        }
        this.pending = [];
        this.pendingBytes = 0;
        this.setState('idle');
    }
    clearTimer() {
        if (this.flushTimer !== null) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }
    stopCapture() {
        this.node?.disconnect();
        this.node = null;
        this.stream?.getTracks().forEach((track) => { track.stop(); });
        this.stream = null;
        void this.audio?.close();
        this.audio = null;
    }
    release() {
        this.clearTimer();
        this.stopCapture();
        this.sessionId = '';
    }
    setState(state) {
        if (this.state !== state) {
            this.state = state;
            this.cb.onState(state);
        }
    }
}
//# sourceMappingURL=VoiceHttpController.js.map