/**
 * 宿主侧 /voice WebSocket：浏览器麦克风 PCM -> 百炼流式 ASR -> partial 上屏；
 * 句末（final）可选地再跑一次“口语转书面”，把增量推回浏览器。
 *
 * 协议（一条 WebSocket，JSON 控制帧 + 二进制 PCM）：
 *   browser -> host:
 *     binary                                  16 kHz Int16 单声道 PCM
 *     {"type":"config","context":"<词表>","polish":true,"dshSessionId":"..."}
 *     {"type":"asr_start"} / {"type":"asr_end"} / {"type":"asr_cancel"}
 *     {"type":"polish","id":"...","text":"..."}
 *   host -> browser:
 *     {"type":"ready","voiceSessionId","asr":"dashscope","polish":true,"hasKey":true}
 *     {"type":"asr_partial","utteranceId","text","sequence"}
 *     {"type":"asr_final","utteranceId","text","sequence"}
 *     {"type":"polish_chunk","id","text","sequence"}   增量片段
 *     {"type":"polish_done","id","text","sequence"}    整理后的全文
 *     {"type":"error","message","sequence"}
 *
 * 每个连接一个 VoiceSession；同一时刻只允许一个 ASR utterance；
 * PCM 走有界队列（BoundedQueue），不做无界 Buffer.concat。
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { type VoiceAdmit } from './voice-trust.ts';
export interface VoiceServerOptions {
    /** 百炼 api key（DASHSCOPE_API_KEY）。 */
    apiKey: string;
    /** 顺稿模型，默认 qwen-flash（OpenAI 兼容端点）。 */
    polishModel?: string;
    /** 打断朗读时取消对应 DSH 会话（保留给未来的 barge-in）。 */
    cancelAgent?: (dshSessionId: string) => void;
    admit?: VoiceAdmit;
}
export declare class VoiceSession {
    private readonly ws;
    private readonly options;
    readonly voiceSessionId: `${string}-${string}-${string}-${string}-${string}`;
    private context;
    private polishEnabled;
    private acceptingAudio;
    private disposed;
    private currentUt;
    private utSeq;
    private msgSeq;
    private polishAbort;
    private polishSeq;
    constructor(ws: WebSocket, options: VoiceServerOptions);
    applyConfig(data: Record<string, unknown>): void;
    feedAudio(pcm: Buffer): void;
    asrStart(): void;
    private startUtterance;
    asrEnd(): void;
    asrCancel(): void;
    /** 口语转书面：流式增量 + 最终全文。失败时回退为原文。 */
    requestPolish(id: string, text: string): Promise<void>;
    dispose(): void;
    private send;
}
export declare function createVoiceUpgrade(options: VoiceServerOptions): {
    handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    close: () => void;
};
//# sourceMappingURL=voice-server.d.ts.map