// Task history and project notes live in the webview's local storage, which holds only a few
// megabytes. When it fills, every AI's bridge call fails, so the error must say how to recover.
export const PURGE_HELP = 'AI Workbench’s saved history is full (storage quota exceeded), so nothing was sent or saved. Tell the user to open the AI handoffs window (a chat’s menu → AI handoffs…) and press “Purge finished tasks”, then retry.';

export const isQuotaError = error =>
  error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014 || /quota/i.test(String(error?.message ?? ''));

// Run a storage write, replacing a quota failure with directions the AI can pass on to the user.
export function guardQuota(write) {
  try { return write(); }
  catch (error) { throw isQuotaError(error) ? new Error(PURGE_HELP, { cause: error }) : error; }
}
