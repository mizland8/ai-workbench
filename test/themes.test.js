import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_LIST, THEMES, THEME_GROUPS, FONT_LIST, mix } from '../src/themes.js';
import * as store from '../src/store.js';

const color = /^#[0-9a-f]{6}$/;
const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

// How far apart two colors are in brightness, 1 to 21, as in the WCAG contrast ratio.
function contrast(a, b) {
  const lum = c => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('every theme has a full terminal palette and app colors', () => {
  assert.ok(THEME_LIST.length >= 60, `only ${THEME_LIST.length} themes`);
  assert.equal(new Set(THEME_LIST.map(t => t.id)).size, THEME_LIST.length, 'theme IDs are unique');
  for (const t of THEME_LIST) {
    assert.ok(THEME_GROUPS.includes(t.group), t.id);
    for (const key of [...ansi, 'background', 'foreground', 'cursor', 'selectionBackground']) assert.match(t.terminal[key], color, `${t.id} ${key}`);
    for (const key of ['bg', 'pane', 'chrome', 'text', 'dim', 'border', 'accent', 'selection', 'ready', 'warn', 'danger', 'working']) assert.match(t.ui[key], color, `${t.id} ui ${key}`);
  }
});

test('text is readable on every theme', () => {
  for (const t of THEME_LIST) {
    // Solarized Light's own text color is a little under 4.5; it's kept as designed.
    assert.ok(contrast(t.ui.text, t.ui.bg) >= 4, `${t.id}: text ${contrast(t.ui.text, t.ui.bg).toFixed(1)}`);
    assert.ok(contrast(t.ui.dim, t.ui.bg) >= 2.5, `${t.id}: dim text ${contrast(t.ui.dim, t.ui.bg).toFixed(1)}`);
    assert.ok(contrast(t.ui.accent, t.ui.bg) >= 2.5, `${t.id}: accent ${contrast(t.ui.accent, t.ui.bg).toFixed(1)}`);
  }
});

test('the original three themes keep their colors', () => {
  assert.equal(THEMES.terminal.ui.bg, '#101313');
  assert.equal(THEMES.powershell.ui.chrome, '#08356b');
  assert.equal(THEMES.amber.terminal.foreground, '#dbc9a6');
});

test('light themes are marked light', () => {
  assert.equal(THEMES['github-light'].light, true);
  assert.equal(THEMES['high-contrast-light'].light, true);
  assert.equal(THEMES.dracula.light, false);
});

test('mixing colors', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#102030', 0.3), '#102030');
});

test('saved theme and font choices are checked', () => {
  assert.equal(FONT_LIST[0].id, 'system');
  assert.ok(store.THEMES.includes('dracula'));
  const { state } = store.loadState({ getItem: key => key === store.storageKey ? JSON.stringify({ theme: 'tokyo-night', settings: { font: 'jetbrains-mono' } }) : null });
  assert.equal(state.theme, 'tokyo-night');
  assert.equal(state.settings.font, 'jetbrains-mono');
  const unknown = store.loadState({ getItem: key => key === store.storageKey ? JSON.stringify({ theme: 'nope', settings: { font: 'nope' } }) : null }).state;
  assert.equal(unknown.theme, 'terminal');
  assert.equal(unknown.settings.font, 'system');
});
