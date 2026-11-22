/**
 * DashScope (阿里百炼) streaming ASR + 口语转书面 polish.
 *
 * ASR: `qwen-audio-3.1-asr-flash-streaming` on the duplex WebSocket API,
 * with `input.context` carrying the user's hot-word / sentence list — the
 * same mechanism 搜狗 calls `speech_contexts` and 火山 calls context.
 *
 *   wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   run-task { model, parameters:{format:'pcm',sample_rate:16000}, input:{context:[...] } }
 *   binary 16k PCM16 mono frames
 *   finish-task -> task-finished
 *   result-generated -> payload.output.sentence { text, sentence_end }
 *
 * Polish: OpenAI-compatible chat completions with `stream: true`; the model
 * rewrites the raw transcript into written Chinese without adding facts.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
const ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
/** 每帧 100 ms 的 16 kHz PCM16。 */
const FRAME_BYTES = 3200;
const FRAME_MS = 100;
function contextPayload(context) {
    const text = (context ?? '').trim();
    if (text === '')
        return {};
    return { context: [{ role: 'user', content: [{ type: 'input_text', text: text.slice(0, 400) }] }] };
}
/**
 * 把 PCM16 流式送进百炼，回调 partial / final。
 * 句界由服务端判定（sentence_end），客户端只负责持续送音频。
 */
export async function asrStream(pcmSource, apiKey, onText, options = {}) {
    const { model = 'qwen-audio-3.1-asr-flash-streaming', context, signal, timeoutMs = 60_000, } = options;
    const taskId = randomUUID();
    const ws = new WebSocket(ASR_URL, {
        headers: { Authorization: `bearer ${apiKey}`, 'X-DashScope-DataInspection': 'enable' },
    });
    let finished = false;
    let sentBytes = 0;
    let wake = null;
    const source = typeof pcmSource === 'string'
        ? async function* () {
            const { readFile } = await import('node:fs/promises');
            const all = await readFile(pcmSource);
            for (let i = 0; i < all.length; i += FRAME_BYTES)
                yield all.subarray(i, i + FRAME_BYTES);
        }()
        : Buffer.isBuffer(pcmSource)
            ? (async function* () {
                for (let i = 0; i < pcmSource.length; i += FRAME_BYTES)
                    yield pcmSource.subarray(i, i + FRAME_BYTES);
            })()
            : pcmSource;
    const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (finished)
                return;
            finished = true;
            try {
                ws.terminate();
            }
            catch { /* ignore */ }
            reject(new Error(`asr timeout after ${timeoutMs} ms`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            if (finished)
                return;
            finished = true;
            cleanup();
            try {
                ws.terminate();
            }
            catch { /* ignore */ }
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
                payload: {
                    task_group: 'audio',
                    task: 'asr',
                    function: 'recognition',
                    model,
                    parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'] },
                    input: contextPayload(context),
                },
            }));
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary)
                return;
            let event;
            try {
                const parsed = JSON.parse(data.toString());
                if (typeof parsed !== 'object' || parsed === null)
                    return;
                event = parsed;
            }
            catch {
                return;
            }
            const header = (event.header ?? {});
            const action = header.event;
            if (action === 'task-started') {
                wake?.();
            }
            else if (action === 'result-generated') {
                const payload = (event.payload ?? {});
                const output = (payload.output ?? {});
                const sentence = output.sentence;
                if (sentence && typeof sentence.text === 'string') {
                    const text = sentence.text.trim();
                    if (text !== '')
                        onText({ text, is_final: sentence.sentence_end === true });
                }
            }
            else if (action === 'task-finished') {
                finished = true;
                cleanup();
                try {
                    ws.close();
                }
                catch { /* ignore */ }
                resolve();
            }
            else if (action === 'task-failed') {
                finished = true;
                cleanup();
                const payload = (event.payload ?? {});
                const msg = String(payload.message ?? header.error_message ?? 'asr task failed');
                try {
                    ws.close();
                }
                catch { /* ignore */ }
                reject(new Error(msg));
            }
        });
        ws.on('error', (err) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            reject(err);
        });
        ws.on('close', () => {
            if (finished)
                return;
            finished = true;
            cleanup();
            resolve();
        });
    });
    // 等 task-started 再送音频；服务端未就绪就灌数据会被丢。
    await new Promise((resolve) => {
        wake = resolve;
        void result.catch(() => resolve());
        setTimeout(resolve, 3000);
    });
    wake = null;
    if (finished) {
        await result.catch(() => { });
        return;
    }
    for await (const chunk of source) {
        if (finished)
            break;
        if (chunk.length === 0)
            continue;
        ws.send(chunk);
        sentBytes += chunk.length;
        await new Promise((r) => setTimeout(r, FRAME_MS));
    }
    if (!finished && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
    }
    await result;
    void sentBytes;
}
/** 三档整理力度：1 只补标点，2 标准（默认），3 较强（可重排语序）。 */
function polishRules(level) {
    const common = [
        '你是语音输入的“口语转书面”处理器，只做整理，不改写立场。',
        '保留专业术语（尤其是医学名词）原样，不要替换成同义词；',
        '不要新增原文没有的信息，不要解释，不要加引号或前后缀；',
        '只输出整理后的正文。',
    ];
    if (level <= 1) {
        return [
            ...common,
            '力度：最轻。只补全标点、把口头数字/单位写成规范写法；',
            '不要删除任何词、不要调整语序、不要合并句子，口癖与重复原样保留。',
        ];
    }
    if (level >= 3) {
        return [
            ...common,
            '力度：较强。删除口癖、重复与自我纠正，补全标点并合理分句；',
            '可以合并被停顿切碎的半句、微调语序让书面语更通顺，但不得改变原意或增减信息。',
        ];
    }
    return [
        ...common,
        '力度：标准。删除口癖、重复、自我纠正与语气词；补全标点并合理分句；',
        '不改变原句顺序与用词，除非明显重复或语病。',
    ];
}
/** 口语转书面：流式返回增量，最后返回全文。 */
export async function polishStream(text, apiKey, onChunk, options = {}) {
    const model = options.model ?? 'qwen-flash';
    const level = Math.min(3, Math.max(1, Math.round(options.level ?? 2)));
    const init = {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
        },
        body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content: polishRules(level).join('\n'),
                },
                { role: 'user', content: text },
            ],
        }),
    };
    if (options.signal !== undefined)
        init.signal = options.signal;
    const res = await fetch(CHAT_URL, init);
    if (!res.ok || res.body === null) {
        const body = await res.text().catch(() => '');
        throw new Error(`polish http ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.startsWith('data:')) {
                const data = line.slice(5).trim();
                if (data !== '' && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        const piece = parsed.choices?.[0]?.delta?.content ?? '';
                        if (piece !== '') {
                            full += piece;
                            onChunk(piece);
                        }
                    }
                    catch { /* ignore malformed sse line */ }
                }
            }
            index = buffer.indexOf('\n');
        }
    }
    return full.trim();
}
//# sourceMappingURL=dashscope.js.map