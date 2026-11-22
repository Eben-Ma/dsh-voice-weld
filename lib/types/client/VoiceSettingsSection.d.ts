/**
 * 设置页「语音输入（百炼）」：顺稿力度（0–3 滑杆）+ 词表/上下文。
 * API Key 由宿主进程从环境变量或 ~/.dsh/.credentials.yaml 读取，前端不碰。
 */
import { type ReactElement } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
export type VoiceSettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'voice'>;
export declare function VoiceSettingsSection(_props: VoiceSettingsSectionProps): ReactElement;
//# sourceMappingURL=VoiceSettingsSection.d.ts.map