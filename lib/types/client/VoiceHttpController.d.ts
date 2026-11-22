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
export type WeldState = 'idle' | 'acquiring' | 'listening' | 'thinking' | 'failed';
export interface WeldCallbacks {
    onState: (state: WeldState) => void;
    onText: (text: string) => void;
    onError: (message: string) => void;
}
export declare class VoiceHttpController {
    private readonly cb;
    private state;
    private stream;
    private audio;
    private node;
    private sessionId;
    private base;
    private pending;
    private pendingBytes;
    private inflight;
    private flushTimer;
    private startedAt;
    private stopped;
    constructor(cb: WeldCallbacks);
    get isActive(): boolean;
    private level;
    start(): Promise<void>;
    private onFrame;
    private flush;
    stop(): Promise<void>;
    /** 取消：停止采集、丢弃本轮，草稿恢复为开始前的样子。 */
    cancel(): void;
    private clearTimer;
    private stopCapture;
    private release;
    private setState;
}
//# sourceMappingURL=VoiceHttpController.d.ts.map