import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 输入框麦克风按钮（听写模式）。
 *
 * - 点一下开始录音，再点一下停止并整理；录音期间按 Esc 取消。
 * - partial / final / 润色结果都通过 inputActions.setDraft 写进输入框，
 *   不在按钮旁边另显示文字（避免和输入栏重复）。
 */
import { useEffect, useRef, useState } from 'react';
import { VoiceHttpController } from "./VoiceHttpController.js";
const ACTIVE = new Set(['acquiring', 'listening', 'thinking']);
export function VoiceInputButton({ inputActions }) {
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);
    const controllerRef = useRef(null);
    const controller = () => {
        if (controllerRef.current === null) {
            controllerRef.current = new VoiceHttpController({
                onState: setState,
                onText: (text) => { inputActions.setDraft(text); },
                onError: (message) => { setError(message); },
            });
        }
        return controllerRef.current;
    };
    /** 录音中按 Esc：取消本轮并恢复原草稿。 */
    useEffect(() => {
        const onKey = (ev) => {
            if (ev.key !== 'Escape')
                return;
            const current = controllerRef.current;
            if (current?.isActive === true) {
                ev.preventDefault();
                current.cancel();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            controllerRef.current?.cancel();
        };
    }, []);
    const active = ACTIVE.has(state);
    const label = error ?? (active ? '停止并整理（Esc 取消）' : '语音输入');
    return (_jsxs("div", { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }, children: [error !== null && (_jsx("span", { style: {
                    position: 'absolute', bottom: '100%', left: 0, maxWidth: 420,
                    whiteSpace: 'normal', fontSize: 11, lineHeight: 1.35, color: '#e5484d',
                    background: 'rgba(0,0,0,0.75)', padding: '2px 6px', borderRadius: 4,
                }, role: "alert", children: error })), _jsxs("button", { type: "button", title: label, "aria-label": label, "aria-pressed": active, onClick: () => {
                    setError(null);
                    const c = controller();
                    if (c.isActive)
                        void c.stop();
                    else
                        void c.start();
                }, style: {
                    position: 'relative',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: active ? 'rgba(239,68,68,0.16)' : 'transparent',
                    color: active ? '#ef4444' : 'currentColor',
                }, children: [_jsxs("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: [_jsx("path", { d: "M8 1a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 1 1-5 0v-3A2.5 2.5 0 0 1 8 1Z", fill: "currentColor" }), _jsx("path", { d: "M3.5 7.5a4.5 4.5 0 0 0 9 0h-1.5a3 3 0 0 1-6 0h-1.5Z", fill: "currentColor" }), _jsx("path", { d: "M8 11.75a4.25 4.25 0 0 1-4.25-4.25H2.25A5.75 5.75 0 0 0 7.25 13.2V15h1.5v-1.8a5.75 5.75 0 0 0 5-5.7h-1.5A4.25 4.25 0 0 1 8 11.75Z", fill: "currentColor" })] }), active && (_jsx("span", { "aria-hidden": true, style: {
                            position: 'absolute', top: 4, right: 4, width: 6, height: 6,
                            borderRadius: 3, background: '#ef4444',
                        } }))] })] }));
}
//# sourceMappingURL=VoiceInputButton.js.map