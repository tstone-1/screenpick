// Canonical shape of every typed-IPC command result. `bindings.ts` (generated
// by tauri-specta; not hand-edited — see AGENTS.md) returns exactly this
// shape from its internal `typedError` helper, but doesn't export a name for
// it. Declared once here so editorCommands.ts and windowPickerCommands.ts
// import the same type instead of each hand-declaring their own copy (N5 in
// the 2026-07 code review found the two had drifted into separate, identical
// declarations). If a future tauri-specta version exports a named result type
// from bindings.ts itself, prefer that and retire this file.
export type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
