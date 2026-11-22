import { VoiceInputButton } from "./VoiceInputButton.js";
import { VoiceSettingsSection } from "./VoiceSettingsSection.js";
import { en, NS, zh } from "./locales.js";
/** Services required by this plugin. */
export const inject = ['slots', 'locale'];
/**
 * Register the voice dictionaries, the composer mic control, and the settings
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
/** 槽位注册失败时停在本插件里，避免把异常抛进整页插件加载。 */
function guard(run) {
    return () => {
        try {
            return run();
        }
        catch (error) {
            console.error('[dsh-voice-weld] voice UI registration failed; other plugins keep running', error);
            return () => { };
        }
    };
}
export function apply(ctx) {
    try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-weld: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.input.right', guard(() => ctx.slots.register({
            name: 'conversation.input.right',
            id: 'voice-weld',
            order: 30,
            locale: NS,
            inject: () => ({ t }),
        }, VoiceInputButton)));
        ctx.slots.inject('settings.section', guard(() => ctx.slots.register({
            name: 'settings.section',
            id: 'voice-weld',
            order: 100,
            label: () => t('voice.nav'),
            locale: NS,
        }, VoiceSettingsSection)));
    }
    catch (error) {
        console.error('[dsh-voice-weld] voice UI failed to start; other plugins keep running', error);
    }
}
//# sourceMappingURL=apply.js.map