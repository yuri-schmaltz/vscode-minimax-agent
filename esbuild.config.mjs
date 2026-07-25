// esbuild build config for MiniMax Agent VSCode extension.
// Builds three bundles:
//   1. Extension host: src/extension.ts -> out/extension.js  (CJS, Node)
//   2. Chat webview:   webview/main.tsx -> dist/webview/main.js  (IIFE, browser)
//   3. Settings webview: webview/settings/main.tsx -> dist/webview/settings/main.js (IIFE, browser)
//
// Run: node esbuild.config.mjs
// Watch: node esbuild.config.mjs --watch
import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watch = process.argv.includes('--watch');
const isDev = process.env.NODE_ENV !== 'production';

const extensionConfig = {
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: resolve(__dirname, 'out/extension.js'),
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
};

const baseWebview = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  loader: {
    '.css': 'css',
    '.svg': 'dataurl',
    '.png': 'dataurl',
  },
  jsx: 'automatic',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  minify: !isDev,
};

const webviewConfig = {
  ...baseWebview,
  entryPoints: [resolve(__dirname, 'webview/main.tsx')],
  outfile: resolve(__dirname, 'dist/webview/main.js'),
};

const settingsConfig = {
  ...baseWebview,
  entryPoints: [resolve(__dirname, 'webview/settings/main.tsx')],
  outfile: resolve(__dirname, 'dist/webview/settings/main.js'),
};

async function ensureDirs() {
  await mkdir(resolve(__dirname, 'out'), { recursive: true });
  await mkdir(resolve(__dirname, 'dist/webview'), { recursive: true });
  await mkdir(resolve(__dirname, 'dist/webview/settings'), { recursive: true });
}

async function copyStaticAssets() {
  // Copy webview CSS so the webview can <link> it with CSP
  await copyFile(
    resolve(__dirname, 'webview/styles.css'),
    resolve(__dirname, 'dist/webview/styles.css'),
  ).catch(() => {
    /* styles.css is optional in some cycles */
  });
  await copyFile(
    resolve(__dirname, 'webview/settings/styles.css'),
    resolve(__dirname, 'dist/webview/settings/styles.css'),
  ).catch(() => {
    /* settings styles are optional in some cycles */
  });
}

async function runBuild() {
  await ensureDirs();
  await build(extensionConfig);
  await build(webviewConfig);
  await build(settingsConfig);
  await copyStaticAssets();
  console.log('[esbuild] build complete');
}

async function runWatch() {
  await ensureDirs();
  const ext = await context(extensionConfig);
  const web = await context(webviewConfig);
  const set = await context(settingsConfig);
  await ext.watch();
  await web.watch();
  await set.watch();
  await copyStaticAssets();
  console.log('[esbuild] watching...');
}

if (watch) {
  runWatch().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runBuild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
