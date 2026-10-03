import { FONTS, DEFAULT_FONT } from './themes.js';
import { monoFonts } from './terminal.js';

// Each font's files load only when it's chosen. Regular and bold, Latin characters.
const loaders = {
  'jetbrains-mono': () => [import('@fontsource/jetbrains-mono/latin-400.css'), import('@fontsource/jetbrains-mono/latin-700.css')],
  'fira-code': () => [import('@fontsource/fira-code/latin-400.css'), import('@fontsource/fira-code/latin-700.css')],
  'fira-mono': () => [import('@fontsource/fira-mono/latin-400.css'), import('@fontsource/fira-mono/latin-700.css')],
  'cascadia-code': () => [import('@fontsource/cascadia-code/latin-400.css'), import('@fontsource/cascadia-code/latin-700.css')],
  'source-code-pro': () => [import('@fontsource/source-code-pro/latin-400.css'), import('@fontsource/source-code-pro/latin-700.css')],
  'ibm-plex-mono': () => [import('@fontsource/ibm-plex-mono/latin-400.css'), import('@fontsource/ibm-plex-mono/latin-700.css')],
  'roboto-mono': () => [import('@fontsource/roboto-mono/latin-400.css'), import('@fontsource/roboto-mono/latin-700.css')],
  'ubuntu-mono': () => [import('@fontsource/ubuntu-mono/latin-400.css'), import('@fontsource/ubuntu-mono/latin-700.css')],
  'inconsolata': () => [import('@fontsource/inconsolata/latin-400.css'), import('@fontsource/inconsolata/latin-700.css')],
  'geist-mono': () => [import('@fontsource/geist-mono/latin-400.css'), import('@fontsource/geist-mono/latin-700.css')],
  'commit-mono': () => [import('@fontsource/commit-mono/latin-400.css'), import('@fontsource/commit-mono/latin-700.css')],
  'monaspace-neon': () => [import('@fontsource/monaspace-neon/latin-400.css'), import('@fontsource/monaspace-neon/latin-700.css')],
  'monaspace-argon': () => [import('@fontsource/monaspace-argon/latin-400.css'), import('@fontsource/monaspace-argon/latin-700.css')],
  'victor-mono': () => [import('@fontsource/victor-mono/latin-400.css'), import('@fontsource/victor-mono/latin-700.css')],
  'maple-mono': () => [import('@fontsource/maple-mono/latin-400.css'), import('@fontsource/maple-mono/latin-700.css')],
  'intel-one-mono': () => [import('@fontsource/intel-one-mono/latin-400.css'), import('@fontsource/intel-one-mono/latin-700.css')],
  'atkinson-hyperlegible-mono': () => [import('@fontsource/atkinson-hyperlegible-mono/latin-400.css'), import('@fontsource/atkinson-hyperlegible-mono/latin-700.css')],
  'noto-sans-mono': () => [import('@fontsource/noto-sans-mono/latin-400.css'), import('@fontsource/noto-sans-mono/latin-700.css')],
  'red-hat-mono': () => [import('@fontsource/red-hat-mono/latin-400.css'), import('@fontsource/red-hat-mono/latin-700.css')],
  'dm-mono': () => [import('@fontsource/dm-mono/latin-400.css'), import('@fontsource/dm-mono/latin-500.css')],
  'space-mono': () => [import('@fontsource/space-mono/latin-400.css'), import('@fontsource/space-mono/latin-700.css')],
  'martian-mono': () => [import('@fontsource/martian-mono/latin-400.css'), import('@fontsource/martian-mono/latin-700.css')],
  'azeret-mono': () => [import('@fontsource/azeret-mono/latin-400.css'), import('@fontsource/azeret-mono/latin-700.css')],
  'sometype-mono': () => [import('@fontsource/sometype-mono/latin-400.css'), import('@fontsource/sometype-mono/latin-700.css')],
  'overpass-mono': () => [import('@fontsource/overpass-mono/latin-400.css'), import('@fontsource/overpass-mono/latin-700.css')],
  'anonymous-pro': () => [import('@fontsource/anonymous-pro/latin-400.css'), import('@fontsource/anonymous-pro/latin-700.css')],
  'courier-prime': () => [import('@fontsource/courier-prime/latin-400.css'), import('@fontsource/courier-prime/latin-700.css')],
  'share-tech-mono': () => [import('@fontsource/share-tech-mono/latin-400.css')],
  'vt323': () => [import('@fontsource/vt323/latin-400.css')],
};

const families = { 'vt323': 'VT323' };

// The CSS font list for a font choice; the platform's monospace fonts stay as the fallback.
export function fontFamily(id) {
  const font = FONTS[id];
  if (!font || id === DEFAULT_FONT) return monoFonts;
  return `'${families[id] ?? font.name}', ${monoFonts}`;
}

// Loads the font's files and waits until they can be drawn, so the terminal measures its cells
// with the real font. Resolves with the CSS font list either way.
export async function loadFont(id) {
  const family = fontFamily(id);
  if (!loaders[id]) return family;
  try {
    await Promise.all(loaders[id]());
    const name = families[id] ?? FONTS[id].name;
    await Promise.all([document.fonts.load(`400 13px '${name}'`), document.fonts.load(`700 13px '${name}'`)]);
  } catch {}
  return family;
}
