import { defineConfig } from 'vite';

// The bundled fonts list a .woff copy after the .woff2 one for old browsers. Every webview this
// app runs in reads .woff2, so the .woff copies are left out of the build.
const woff2Only = {
  name: 'woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('@fontsource/') || !id.endsWith('.css')) return null;
    return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, ''), map: null };
  },
};

export default defineConfig({ plugins: [woff2Only] });
