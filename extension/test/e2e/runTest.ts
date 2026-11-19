import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/kconfig.e2e.js');
    const workspacePath = path.resolve(extensionDevelopmentPath, '..');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, '--disable-extensions'],
    });
  } catch (err) {
    console.error('Failed to run VSCode Extension Host E2E tests:', err);
    process.exit(1);
  }
}

void main();
