import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { polishStream } from "./dashscope.js";
import { AsrUtterance } from "./asr-utterance.js";
import { isTrustedVoiceRequest, readVoiceOperator, rejectWebSocketUpgrade } from "./voice-trust.js";
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** 临时诊断日志：升级被拒时写一行到系统临时目录，便于排查“后端未启动”。 */
function logLine(line) {
    try {
        appendFileSync(join(tmpdir(), 'dsh-voice-weld.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        /* 日志失败不影响主流程 */
    }
}
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 8;
const MAX_SESSION_MS = 60 * 60 * 1000;
/** 能量门限：静音帧不启动新的识别回合。 */
const VOICE_RMS_THRESHOLD = 300;
/** 词表上限（百炼 input.context 单轮 400 字符）。 */
const MAX_CONTEXT_CHARS = 400;
function hasVoiceEnergy(pcm, threshold = VOICE_RMS_THRESHOLD) {
    const n = Math.floor(pcm.length / 2);
    if (n === 0)
        return false;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = pcm.readInt16LE(i * 2);
        sum += s * s;
    }
    return Math.sqrt(sum / n) > threshold;
}
export class VoiceSession {
    ws;
    options;
    voiceSessionId = randomUUID();
    context = '';
    polishEnabled = true;
    acceptingAudio = false;
    disposed = false;
    currentUt = null;
    utSeq = 0;
    msgSeq = 0;
    polishAbort = null;
    polishSeq = 0;
    constructor(ws, options) {
        this.ws = ws;
        this.options = options;
    }
    applyConfig(data) {
        if (typeof data.context === 'string')
            this.context = data.context.slice(0, MAX_CONTEXT_CHARS);
        if (typeof data.polish === 'boolean')
            this.polishEnabled = data.polish;
    }
    feedAudio(pcm) {
        if (!this.acceptingAudio || this.disposed)
            return;
        if (this.currentUt === null) {
            if (!hasVoiceEnergy(pcm))
                return;
            this.startUtterance();
        }
        const ut = this.currentUt;
        if (ut !== null && !ut.push(pcm)) {
            ut.cancel();
            if (this.currentUt === ut)
                this.currentUt = null;
            this.acceptingAudio = false;
            this.send({ type: 'error', message: 'asr: audio queue overflow' });
        }
    }
    asrStart() {
        if (this.disposed)
            return;
        this.currentUt?.cancel();
        this.currentUt = null;
        this.acceptingAudio = true;
    }
    startUtterance() {
        const id = String(++this.utSeq);
        const session = this.voiceSessionId;
        const ut = new AsrUtterance(this.options.apiKey, id, (text) => {
            if (this.currentUt === ut)
                this.currentUt = null;
            this.acceptingAudio = false;
            this.send({ type: 'asr_final', voiceSessionId: session, utteranceId: id, text });
            if (this.polishEnabled)
                void this.requestPolish(`u${id}`, text);
        }, (text) => {
            this.send({ type: 'asr_partial', voiceSessionId: session, utteranceId: id, text });
        }, (err) => {
            if (this.currentUt === ut)
                this.currentUt = null;
            this.acceptingAudio = false;
            this.send({ type: 'error', message: `asr: ${err.message}` });
        }, () => {
            if (this.currentUt === ut)
                this.currentUt = null;
        }, this.context);
        this.currentUt = ut;
        ut.start();
    }
    asrEnd() {
        this.acceptingAudio = false;
        this.currentUt?.end();
        this.currentUt = null;
    }
    asrCancel() {
        this.acceptingAudio = false;
        this.currentUt?.cancel();
        this.currentUt = null;
    }
    /** 口语转书面：流式增量 + 最终全文。失败时回退为原文。 */
    async requestPolish(id, text) {
        this.polishAbort?.abort();
        const abort = new AbortController();
        this.polishAbort = abort;
        const seq = ++this.polishSeq;
        let full = '';
        try {
            const result = await polishStream(text, this.options.apiKey, (chunk) => {
                full += chunk;
                this.send({ type: 'polish_chunk', id, text: chunk, sequence: seq, partial: full });
            }, this.options.polishModel === undefined
                ? { signal: abort.signal }
                : { model: this.options.polishModel, signal: abort.signal });
            if (abort.signal.aborted)
                return;
            this.send({ type: 'polish_done', id, text: result === '' ? text : result, sequence: seq });
        }
        catch (err) {
            if (abort.signal.aborted)
                return;
            this.send({ type: 'error', message: `polish: ${err.message}` });
            this.send({ type: 'polish_done', id, text, sequence: seq, fallback: true });
        }
        finally {
            if (this.polishAbort === abort)
                this.polishAbort = null;
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.polishAbort?.abort();
        this.asrCancel();
    }
    send(obj) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify({ ...obj, sequence: ++this.msgSeq }));
    }
}
export function createVoiceUpgrade(options) {
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws) => {
        if (wss.clients.size > MAX_CONNECTIONS) {
            ws.close(1008, 'too many connections');
            return;
        }
        const lifetime = setTimeout(() => { ws.terminate(); }, MAX_SESSION_MS);
        ws.on('close', () => { clearTimeout(lifetime); });
        const session = new VoiceSession(ws, options);
        ws.once('close', () => { session.dispose(); });
        ws.send(JSON.stringify({
            type: 'ready',
            voiceSessionId: session.voiceSessionId,
            asr: 'dashscope',
            polish: true,
            hasKey: options.apiKey.length > 0,
        }));
        ws.on('message', (data, isBinary) => {
            const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (isBinary) {
                if (buf.length > MAX_FRAME_BYTES)
                    return;
                session.feedAudio(buf);
                return;
            }
            if (buf.length > 64 * 1024)
                return;
            try {
                const parsed = JSON.parse(buf.toString('utf8'));
                if (typeof parsed !== 'object' || parsed === null)
                    return;
                const msg = parsed;
                const isMySession = (m) => typeof m.voiceSessionId !== 'string' || m.voiceSessionId === session.voiceSessionId;
                switch (msg.type) {
                    case 'config':
                        if (isMySession(msg))
                            session.applyConfig(msg);
                        break;
                    case 'asr_start':
                        if (isMySession(msg))
                            session.asrStart();
                        break;
                    case 'asr_end':
                        if (isMySession(msg))
                            session.asrEnd();
                        break;
                    case 'asr_cancel':
                        if (isMySession(msg))
                            session.asrCancel();
                        break;
                    case 'polish': {
                        if (!isMySession(msg))
                            break;
                        const text = typeof msg.text === 'string' ? msg.text : '';
                        if (text.trim() === '')
                            break;
                        const id = typeof msg.id === 'string' ? msg.id : 'manual';
                        session.requestPolish(id, text);
                        break;
                    }
                    default: break;
                }
            }
            catch {
                /* ignore malformed control frames */
            }
        });
    });
    return {
        handle: (req, socket, head) => {
            const trusted = isTrustedVoiceRequest(req);
            logLine(`upgrade url=${req.url ?? ''} host=${req.headers.host ?? ''} origin=${req.headers.origin ?? ''} trusted=${trusted}`);
            if (!trusted) {
                logLine('reject: untrusted origin/host (403)');
                rejectWebSocketUpgrade(socket, 403);
                return;
            }
            let admission;
            try {
                admission = options.admit?.(req) ?? { rejection: 401 };
            }
            catch (error) {
                logLine(`reject: admit threw ${String(error)} (401)`);
                rejectWebSocketUpgrade(socket, 401);
                return;
            }
            if ('rejection' in admission) {
                logLine(`reject: admission ${String(admission.rejection)}`);
                rejectWebSocketUpgrade(socket, admission.rejection);
                return;
            }
            if (readVoiceOperator(admission.peer) === undefined) {
                logLine(`reject: peer without readable operator (401) peerKeys=${Object.keys(admission.peer).join(',')}`);
                rejectWebSocketUpgrade(socket, 401);
                return;
            }
            logLine('accepted');
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        },
        close: () => {
            for (const client of wss.clients)
                client.terminate();
            wss.close();
        },
    };
}
//# sourceMappingURL=voice-server.js.map