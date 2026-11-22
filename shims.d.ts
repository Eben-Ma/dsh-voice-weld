declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type PropsLocale<K extends string = string> = { t: (key: string) => string } & Record<string, unknown>
  export type PropsRuntime<S extends string = string> = {
    inputActions: { setDraft: (text: string) => void }
  } & Record<string, unknown>
}
declare module '@deepseek-ai/dsh-client-runtime' { const x: any; export default x }
declare module '@deepseek-ai/dsh-client-ui-primitives' { export const a: any }
declare module '@deepseek-ai/cordis' {
  export type Context = any
}
