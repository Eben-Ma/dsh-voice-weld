/**
 * Host 入口：把语音输入挂成 `/api/voice-weld/*` 的同源 HTTP 端点。
 *
 * 为什么不是 WebSocket：桌面版页面跑在 `dsh-app://app/` 下，自定义协议只
 * 代理 HTTP，不转发 WS 升级；同源 fetch 则能正常到达 Host。
 *
 * - ASR / 顺稿都走百炼（DashScope），key 优先取 `DASHSCOPE_API_KEY`
 *   环境变量，取不到再从 `~/.dsh/.credentials.yaml` 读（不落前端）。
 * - 不需要任何常驻代理进程：DSH 启动即生效，DSH 退出即回收。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerVoiceHttp } from "./host/voice-http.js";
/** 需要 Host 的 webServer 才能挂载 `/api` 路由。 */
export const inject = ['webServer'];
/** 从 ~/.dsh/.credentials.yaml 的 refs 段读一个 key。 */
function readCredential(name) {
    try {
        const file = join(homedir(), '.dsh', '.credentials.yaml');
        const text = readFileSync(file, 'utf8');
        const match = text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
        return match?.[1] ?? '';
    }
    catch {
        return '';
    }
}
function resolveApiKey() {
    const fromEnv = process.env.DASHSCOPE_API_KEY ?? '';
    return fromEnv !== '' ? fromEnv : readCredential('DASHSCOPE_API_KEY');
}
export function apply(ctx) {
    const apiKey = resolveApiKey();
    registerVoiceHttp(ctx, {
        apiKey,
        polishModel: process.env.VOICE_POLISH_MODEL ?? 'qwen-flash',
    });
    if (apiKey === '') {
        ctx.logger?.warn?.('[voice-weld] 未找到 DASHSCOPE_API_KEY，语音输入不可用');
    }
}
//# sourceMappingURL=index.js.map