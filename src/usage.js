// Usage arrives as quarter-hour buckets (see src-tauri/src/usage.rs); these add them up into the
// local day and the last seven days, in this computer's time zone.
const emptyAmount = () => ({ tokens: 0, input: 0, output: 0, cached: 0, replies: 0, cost: 0 });

function add(total, amount) {
  for (const key of Object.keys(total)) total[key] += amount[key] ?? 0;
  return total;
}

export function usageTotals(report, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  return report.tools.map(tool => ({
    id: tool.id, limits: tool.limits, plan: tool.plan, problem: tool.problem,
    limitsUpdatedAt: tool.limitsUpdatedAt, limitsProblem: tool.limitsProblem,
    today: tool.buckets.filter(b => b.start >= today.getTime()).reduce(add, emptyAmount()),
    week: tool.buckets.filter(b => b.start >= week.getTime()).reduce(add, emptyAmount()),
  }));
}

export function formatTokens(n) {
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, unit] of units) {
    if (n >= size) return `${(n / size).toFixed(n >= size * 100 ? 0 : 1).replace(/\.0$/, '')}${unit}`;
  }
  return String(Math.round(n));
}

// Keep a countdown beside the local reset time so a subscription window is easy to plan around.
export function formatLimitCountdown(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((ms - now) / 60_000));
  if (!minutes) return 'awaiting refresh';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

// "8:45 PM" for a reset within a day, otherwise "Fri, Oct 2 3:15 PM".
export function formatLimitReset(ms, now = Date.now()) {
  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return ms - now < 24 * 3600 * 1000 ? time : `${new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function headerAllowances(report, now = Date.now()) {
  return (report?.tools ?? []).flatMap(tool => {
    const current = tool.limits.filter(limit => !limit.resetsAt || limit.resetsAt > now);
    if (!current.length) return [];
    return [{ id: tool.id, usedPercent: Math.max(...current.map(limit => limit.usedPercent)), stale: !!tool.limitsProblem }];
  });
}

// Allowance resets to announce. `tracked` maps "tool:label" to the next reset of that allowance;
// each usage report updates it. Only resets still ahead are taken, so restarting the app or an
// older cached report never announces one twice, and an allowance nobody used isn't announced.
export function trackResets(tracked, report, now = Date.now()) {
  for (const tool of report?.tools ?? []) {
    for (const limit of tool.limits ?? []) {
      if (!limit.resetsAt || limit.resetsAt <= now) continue;
      const key = `${tool.id}:${limit.label}`;
      const known = tracked.get(key);
      // The same window can come back with a reset time a few seconds off; keep the highest use seen.
      const sameWindow = known && Math.abs(known.resetsAt - limit.resetsAt) < 10 * 60_000;
      tracked.set(key, { tool: tool.id, label: limit.label, resetsAt: limit.resetsAt,
        usedPercent: Math.max(limit.usedPercent ?? 0, sameWindow ? known.usedPercent : 0) });
    }
  }
  return tracked;
}

// The tracked resets whose time has come, removed from `tracked`.
export function takeDueResets(tracked, now = Date.now()) {
  const due = [];
  for (const [key, reset] of tracked) {
    if (reset.resetsAt > now) continue;
    tracked.delete(key);
    if (reset.usedPercent >= 1) due.push(reset);
  }
  return due;
}
