import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const electron = process.env.PASEO_DSH_ELECTRON ?? path.join(homedir(), 'AppData/Local/Programs/Paseo/Paseo.exe');
test('Desktop Electron runs the ACP bridge as Node and preserves the target launch and session environment', {
  skip: !existsSync(electron), timeout: 20000,
}, async () => {
  const child = spawn(electron, [fileURLToPath(new URL('./fixtures/desktop-host.mjs', import.meta.url)), process.execPath], {
    windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_DSH_ENGINE: 'acp' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout.trim());
  assert.ok(result.electron, 'The regression must run under the actual Desktop Electron executable');
  assert.deepEqual(result.target, { electronRunAsNode: null, launchMarker: 'daemon launch value', sessionMarker: 'per session value' });
});
