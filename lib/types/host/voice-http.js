/**
 * 桌面端可用的 HTTP 传输（替代 WebSocket）。
 *
 * 桌面版页面跑在自定义协议 `dsh-app://app/` 下，`location.host` 是 `app`，
 * 既拼不出可用的 WS 地址，自定义协议也不转发 WS 升级；但同源的 fetch 会
 * 被代理到真正的 Host，所以语音输入改走 `/api/voice-weld/*` 四个端点：
 *
 *   POST /api/voice-weld/start   {context,polish}   → {id}
 *   POST /api/voice-weld/chunk   ?id=…（octet-stream）→ {partial}
 *   POST /api/voice-weld/end     {id}               → {final}
 *   POST /api/voice-weld/polish  {text}             → {text}
 *
 * 鉴权由 `ctx.connection.fetch` 统一处理（浏览器 cookie / owner peer）。
 */
import { randomUUID } from 'node:crypto';
import { AsrUtterance } from "./asr-utterance.js";
import { polishStream } from "./dashscope.js";
/**
 * 拼接两段识别结果，消掉首尾重叠。
 *
 * 流式服务偶尔先给一个短句 final（例如「我」），紧接着同一句继续以
 * partial 回来（「我们先做…」），直接相加会出现「我我们」。这里按
 * 最长重叠（2–6 字）去重，重叠不足 2 字时按正常拼接处理。
 */
function mergeText(head, piece) {
    if (head === '')
        return piece;
    if (piece === '')
        return head;
    const max = Math.min(6, head.length, piece.length);
    for (let size = max; size >= 2; size -= 1) {
        if (head.endsWith(piece.slice(0, size)))
            return head + piece.slice(size);
    }
    return head + piece;
}
const PREFIX = '/api/voice-weld';
function json(data, status = 200) {
    return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
async function readJson(req) {
    try {
        const value = await req.json();
        return value !== null && typeof value === 'object' ? value : {};
    }
    catch {
        return {};
    }
}
function field(body, name) {
    const value = body[name];
    return typeof value === 'string' ? value : '';
}
export function registerVoiceHttp(ctx, options) {
    const sessions = new Map();
    const { apiKey, polishModel = 'qwen-flash' } = options;
    const start = async (req) => {
        if (apiKey === '')
            return json({ error: 'missing DASHSCOPE_API_KEY' }, 503);
        const body = await readJson(req);
        const context = field(body, 'context').slice(0, 400);
        const wantPolish = body.polish !== false;
        const id = randomUUID();
        let resolve = () => { };
        const done = new Promise((r) => { resolve = r; });
        const session = {
            id,
            transcript: '',
            partial: '',
            done,
            resolve,
            polish: wantPolish,
            utt: null,
        };
        const full = () => mergeText(session.transcript, session.partial);
        session.utt = new AsrUtterance(apiKey, id, 
        // 一次录音里可以有多个句子：逐句累积，交给 end 汇总。
        (final) => { session.transcript = mergeText(session.transcript, final); session.partial = ''; }, (partial) => { session.partial = partial; }, (err) => { session.error = err; session.resolve(full()); }, () => { session.resolve(full()); }, context);
        sessions.set(id, session);
        session.utt.start();
        return json({ id, hasKey: true, polish: wantPolish });
    };
    const chunk = async (req) => {
        const id = new URL(req.url).searchParams.get('id') ?? '';
        const session = sessions.get(id);
        if (session === undefined)
            return json({ error: 'unknown session' }, 404);
        const bytes = Buffer.from(await req.arrayBuffer());
        if (bytes.length > 0)
            session.utt.push(bytes);
        return json({ partial: mergeText(session.transcript, session.partial) });
    };
    const end = async (req) => {
        const body = await readJson(req);
        const id = field(body, 'id');
        const session = sessions.get(id);
        if (session === undefined)
            return json({ error: 'unknown session' }, 404);
        session.utt.end();
        const fallback = () => mergeText(session.transcript, session.partial);
        const timeout = new Promise((resolve) => { setTimeout(() => resolve(fallback()), 20_000); });
        const final = await Promise.race([session.done, timeout]);
        sessions.delete(id);
        return json({ final, error: session.error?.message ?? '' });
    };
    const polish = async (req) => {
        const body = await readJson(req);
        const text = field(body, 'text').trim();
        if (text === '')
            return json({ text: '' });
        if (apiKey === '')
            return json({ text, error: 'missing DASHSCOPE_API_KEY' });
        try {
            const rawLevel = typeof body.level === 'number' ? body.level : 2;
            const level = Math.min(3, Math.max(1, Math.round(rawLevel)));
            const out = await polishStream(text, apiKey, () => { }, { model: polishModel, level });
            const trimmed = out.trim();
            return json({ text: trimmed === '' ? text : trimmed });
        }
        catch (err) {
            return json({ text, error: err instanceof Error ? err.message : 'polish failed' });
        }
    };
    const routes = [
        { path: `${PREFIX}/start`, methods: ['POST'], requestBody: 'buffered', fetch: start },
        { path: `${PREFIX}/chunk`, methods: ['POST'], requestBody: 'buffered', fetch: chunk },
        { path: `${PREFIX}/end`, methods: ['POST'], requestBody: 'buffered', fetch: end },
        { path: `${PREFIX}/polish`, methods: ['POST'], requestBody: 'buffered', fetch: polish },
    ];
    ctx.inject(['connection'], (connCtx) => {
        const connection = connCtx.connection;
        for (const route of routes) {
            connCtx.effect(() => connection.fetch.register(route), `ui-voice-weld: ${route.path}`);
        }
    });
}
//# sourceMappingURL=voice-http.js.map