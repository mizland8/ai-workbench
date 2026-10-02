import { invoke, Channel } from '@tauri-apps/api/core';

// The page also opens in a plain browser (vite dev/preview), where there are no live sessions.
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const desktopOnly = 'Live sessions run in the AI Workbench desktop app.';

export const detectTools = (toolPaths, refresh = false) =>
  isDesktop ? invoke('detect_tools', { toolPaths, refresh }) : Promise.resolve(null);

// Recent token use per AI tool, read from each tool's own records (src-tauri/src/usage.rs).
export const usageSummary = (toolPaths, refreshLimits = false) => isDesktop ? invoke('usage_summary', { toolPaths, refreshLimits }) : Promise.resolve(null);

// Output arrives as raw bytes; exits, notices and discovered session IDs arrive as objects.
export function startTerminal(request, onOutput, onEvent) {
  if (!isDesktop) return Promise.reject(new Error(desktopOnly));
  const events = new Channel(message => message instanceof ArrayBuffer ? onOutput(new Uint8Array(message)) : onEvent(message));
  return invoke('terminal_start', { request, events });
}

// A reloaded page has no panes, so terminals left over from before the reload are stopped.
export const resetTerminals = () => isDesktop ? invoke('terminal_stop_all').catch(() => {}) : Promise.resolve();
export const writeTerminal = (id, data) => invoke('terminal_write', { id, data }).catch(() => {});
export const resizeTerminal = (id, cols, rows) => invoke('terminal_resize', { id, cols, rows }).catch(() => {});
export const stopTerminal = id => invoke('terminal_stop', { id }).catch(() => {});
export const pathInfo = path => isDesktop ? invoke('path_info', { path }) : Promise.resolve(null);
export const homeDir = () => isDesktop ? invoke('home_dir') : Promise.resolve('');

export async function pickFolder(defaultPath) {
  if (!isDesktop) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open({ directory: true, defaultPath: defaultPath || undefined });
}

export async function pickFiles(defaultPath) {
  if (!isDesktop) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, defaultPath: defaultPath || undefined });
  return picked ? [picked].flat() : [];
}

export async function pickProgram() {
  if (!isDesktop) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open({ multiple: false, directory: false });
}

export async function openLink(url) {
  if (!isDesktop) return void window.open(url, '_blank', 'noopener');
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  return openUrl(url);
}

export async function notify(title, body) {
  if (!isDesktop) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
    if (await isPermissionGranted() || await requestPermission() === 'granted') sendNotification({ title, body });
  } catch {}
}

// Asks the desktop to draw attention to the window; what that looks like depends on the system.
export async function requestAttention() {
  if (!isDesktop) return;
  const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
  getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
}

export async function setWindowTitle(title) {
  document.title = title;
  if (!isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().setTitle(title).catch(() => {});
}

// Files dragged from the file manager; positions are in physical pixels.
export async function onFileDrop(handler) {
  if (!isDesktop) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent(event => handler(event.payload));
}
