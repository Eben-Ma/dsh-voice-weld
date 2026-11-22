import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置页「语音输入（百炼）」：顺稿力度（0–3 滑杆）+ 词表/上下文。
 * API Key 由宿主进程从环境变量或 ~/.dsh/.credentials.yaml 读取，前端不碰。
 */
import { useState } from 'react';
const KEY_LEVEL = 'dsh-voice-polish-level';
const KEY_LEGACY = 'dsh-voice-polish';
const KEY_CONTEXT = 'dsh-voice-context';
const LEVELS = [
    { value: 0, name: '不改写', desc: '识别到什么就写什么，只补不加。' },
    { value: 1, name: '轻度', desc: '只补标点、规范数字单位，不删词、不调语序。' },
    { value: 2, name: '标准', desc: '去口癖、重复、自我纠正，补标点并分句。' },
    { value: 3, name: '较强', desc: '可合并被停顿切碎的半句、微调语序，但不增删信息。' },
];
function readLevel() {
    const stored = localStorage.getItem(KEY_LEVEL);
    if (stored !== null) {
        const value = Number(stored);
        if (Number.isFinite(value))
            return Math.min(3, Math.max(0, Math.round(value)));
    }
    // 兼容旧开关：dsh-voice-polish = '0' 视为「不改写」。
    return localStorage.getItem(KEY_LEGACY) === '0' ? 0 : 2;
}
function readContext() {
    return localStorage.getItem(KEY_CONTEXT) ?? '';
}
export function VoiceSettingsSection(_props) {
    const [level, setLevel] = useState(readLevel);
    const [context, setContext] = useState(readContext);
    const [saved, setSaved] = useState('idle');
    const changeLevel = (value) => {
        setLevel(value);
        localStorage.setItem(KEY_LEVEL, String(value));
        setSaved('ok');
        setTimeout(() => { setSaved('idle'); }, 1200);
    };
    const save = () => {
        // 百炼 input.context 每轮上限 400 字符，这里按上限截断并提示。
        localStorage.setItem(KEY_CONTEXT, context.slice(0, 400));
        localStorage.setItem(KEY_LEVEL, String(level));
        setSaved('ok');
        setTimeout(() => { setSaved('idle'); }, 1200);
    };
    const row = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 };
    const hint = { fontSize: 12, opacity: 0.65, lineHeight: 1.6, margin: 0 };
    const current = LEVELS[level] ?? LEVELS[2];
    return (_jsxs("section", { style: { display: 'flex', flexDirection: 'column', gap: 12 }, children: [_jsxs("div", { children: [_jsx("h3", { style: { margin: '0 0 4px', fontSize: 14 }, children: "\u8BED\u97F3\u8F93\u5165\uFF08\u767E\u70BC\uFF09" }), _jsx("p", { style: hint, children: "\u6D41\u5F0F\u8BC6\u522B\uFF1A\u8FB9\u8BF4\u8FB9\u51FA\u5B57\uFF1B\u505C\u6B62\u5F55\u97F3\u540E\u6309\u4E0B\u9762\u7684\u529B\u5EA6\u505A\u4E00\u6B21\u300C\u53E3\u8BED\u8F6C\u4E66\u9762\u300D\u3002 \u5BC6\u94A5\u7531 DSH \u4E3B\u8FDB\u7A0B\u8BFB\u53D6\uFF0C\u4E0D\u9700\u8981\u5728\u8FD9\u91CC\u586B\u3002" })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [_jsxs("span", { style: { fontSize: 13 }, children: ["\u6574\u7406\u529B\u5EA6\uFF1A", _jsx("strong", { children: current.name })] }), _jsx("input", { type: "range", min: 0, max: 3, step: 1, value: level, onChange: (e) => { changeLevel(Number(e.target.value)); }, style: { width: '100%' } }), _jsx("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.6 }, children: LEVELS.map((item) => _jsx("span", { children: item.name }, item.value)) }), _jsx("span", { style: hint, children: current.desc })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [_jsx("span", { style: { fontSize: 13 }, children: "\u8BCD\u8868 / \u4E0A\u4E0B\u6587\uFF08\u6BCF\u884C\u6216\u7A7A\u683C\u5206\u9694\uFF0C\u6700\u591A 400 \u5B57\uFF09" }), _jsx("textarea", { value: context, onChange: (e) => { setContext(e.target.value); }, rows: 4, placeholder: "\u4F8B\uFF1A\u808B\u5F13 \u8179\u8154\u79EF\u6DB2 \u813E\u810F \u63A2\u67E5 \u6B62\u8840 \u7F1D\u5408", style: {
                            width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13,
                            padding: 8, borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)',
                            background: 'transparent', color: 'inherit',
                        } }), _jsxs("span", { style: hint, children: [context.length, "/400 \u00B7 \u8BF4\u8BDD\u65F6\u82E5\u542B\u8FD9\u4E9B\u8BCD\uFF0C\u8BC6\u522B\u4F1A\u4F18\u5148\u9009\u5B83\u4EEC\u3002"] })] }), _jsxs("div", { style: row, children: [_jsx("button", { type: "button", onClick: save, style: { padding: '6px 14px', borderRadius: 8, cursor: 'pointer' }, children: "\u4FDD\u5B58\u8BCD\u8868" }), saved === 'ok' && _jsx("span", { style: { fontSize: 12, color: '#22c55e' }, children: "\u5DF2\u4FDD\u5B58\uFF0C\u4E0B\u4E00\u6B21\u5F55\u97F3\u751F\u6548" })] })] }));
}
//# sourceMappingURL=VoiceSettingsSection.js.map