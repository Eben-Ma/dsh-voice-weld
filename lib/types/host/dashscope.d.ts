export interface AsrResult {
    text: string;
    is_final: boolean;
}
export interface AsrStreamOptions {
    model?: string;
    /** 词表/上下文句子，喂给 input.context；最长 400 字符。 */
    context?: string;
    endpointingMs?: number;
    signal?: AbortSignal;
    /** 建连与整体超时。 */
    timeoutMs?: number;
}
/**
 * 把 PCM16 流式送进百炼，回调 partial / final。
 * 句界由服务端判定（sentence_end），客户端只负责持续送音频。
 */
export declare function asrStream(pcmSource: AsyncIterable<Buffer> | Buffer | string, apiKey: string, onText: (result: AsrResult) => void, options?: AsrStreamOptions): Promise<void>;
/** 口语转书面：流式返回增量，最后返回全文。 */
export declare function polishStream(text: string, apiKey: string, onChunk: (chunk: string) => void, options?: {
    model?: string;
    signal?: AbortSignal;
    level?: number;
}): Promise<string>;
//# sourceMappingURL=dashscope.d.ts.map