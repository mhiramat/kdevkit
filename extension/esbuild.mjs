import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

function copyCodicons() {
  const srcDir = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const destDir = path.join(__dirname, 'dist', 'webview', 'codicons');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    const srcFile = path.join(srcDir, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(destDir, file));
    }
  }
}

/** @type {esbuild.BuildOptions} */
const extensionHostConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview-ui/src/main.tsx'],
  bundle: true,
  outfile: 'dist/webview/kconfig.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const e2eTestConfig = {
  entryPoints: [
    'test/e2e/runTest.ts',
    'test/e2e/suite/kconfig.e2e.ts',
  ],
  bundle: true,
  outdir: 'dist/test/e2e',
  external: ['vscode', '@vscode/test-electron'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

async function run() {
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  copyCodicons();

  if (isWatch) {
    const extCtx = await esbuild.context(extensionHostConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[esbuild] Watching extension and webview targets...');
  } else {
    const tasks = [
      esbuild.build(extensionHostConfig),
      esbuild.build(webviewConfig),
    ];
    if (fs.existsSync(path.join(__dirname, 'test', 'e2e', 'runTest.ts'))) {
      tasks.push(esbuild.build(e2eTestConfig));
    }
    await Promise.all(tasks);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
