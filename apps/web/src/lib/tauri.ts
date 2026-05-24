// Runtime detection + lazy module loading for the Tauri host.
//
// The web SPA runs in two environments: a regular browser (served by
// the API) and embedded inside the Tauri desktop shell. We can't
// statically import `@tauri-apps/api` because that would either crash
// in the browser at runtime (when Tauri internals are absent) or bloat
// the browser bundle. Dynamic imports keep the Tauri code path off
// the critical path until something asks for it.

// Module types via Awaited<typeof loaderFn>. Avoids `typeof import('...')`
// (forbidden by the consistent-type-imports rule) without pulling the
// modules in eagerly at module load — the loaders are values whose return
// types describe the dynamically-imported module.
const loadCoreModule = async () => import('@tauri-apps/api/core');
const loadEventModule = async () => import('@tauri-apps/api/event');
type TauriCoreModule = Awaited<ReturnType<typeof loadCoreModule>>;
type TauriEventModule = Awaited<ReturnType<typeof loadEventModule>>;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function assertTauri(): void {
  if (!isTauri()) {
    throw new Error('Tauri APIs requested outside the desktop shell');
  }
}

let coreModulePromise: Promise<TauriCoreModule> | null = null;
let eventModulePromise: Promise<TauriEventModule> | null = null;

export async function tauriCore(): Promise<TauriCoreModule> {
  assertTauri();
  coreModulePromise ??= loadCoreModule();
  return coreModulePromise;
}

export async function tauriEvent(): Promise<TauriEventModule> {
  assertTauri();
  eventModulePromise ??= loadEventModule();
  return eventModulePromise;
}

// Convenience: invoke a Tauri command. Mirrors `core.invoke<T>` but
// guards on the runtime check so call sites don't have to. Returns
// `unknown` when called without an explicit type argument — callers
// that don't care about the response (e.g. `await invoke('foo')`)
// can ignore it; callers that do specify `invoke<MyShape>(...)`.
export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const core = await tauriCore();
  return core.invoke<T>(command, args);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T narrows the handler's payload at the call site; without it consumers would lose Tauri event-payload type safety.
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const eventModule = await tauriEvent();
  return eventModule.listen<T>(event, (e) => {
    handler(e.payload);
  });
}

// Brand the global so TS doesn't complain when feature code probes for
// `window.__TAURI_INTERNALS__` directly. The shape is opaque on purpose:
// nothing here should depend on the field's value.
declare global {
  interface Window {
    readonly __TAURI_INTERNALS__?: unknown;
  }
}
