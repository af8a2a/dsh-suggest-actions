import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const windows = process.platform === 'win32'
const installer = fileURLToPath(new URL('../install.ps1', import.meta.url))
const shells = windows
  ? [join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh.exe']
  : []

for (const shell of shells) {
  const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
  test(`installer preserves UTF-8 JSON through install and uninstall (${basename(shell)})`, {
    // A restricted sandbox can refuse to spawn the shell at all (EPERM); that is
    // an environment limit, not an installer defect, so the case is skipped.
    skip: available.error !== undefined || available.status !== 0,
  }, (t) => {
    assert.equal(available.status, 0, String(available.stdout ?? '') + String(available.stderr ?? ''))
    const temporaryRoot = realpathSync(tmpdir())
    const home = mkdtempSync(join(temporaryRoot, 'dsh-install-test-'))
    assert.equal(dirname(home), temporaryRoot)
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const profile = join(home, '.dsh/profiles/desktop')
    mkdirSync(profile, { recursive: true })
    const manifestPath = join(profile, 'package.json')
    const original = {
      name: 'dsh-profile-desktop',
      description: '\u4e2d\u6587 profile \u00e9',
      dependencies: { 'existing-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['existing-bundle'], label: '\u4fdd\u7559' } },
    }
    writeFileSync(manifestPath, JSON.stringify(original) + '\n', 'utf8')
    const target = join(profile, 'node_modules/dsh-suggest-actions')
    const run = (uninstall = false) => {
      // The fixture home is isolated, so a running real desktop cannot rewrite it.
      // -Copy keeps this case offline: the link path needs a real dsh CLI and pnpm.
      const command = 'function Get-Process {}\n& $env:DSH_INSTALL_TEST_SCRIPT -Copy' + (uninstall ? ' -Uninstall' : '')
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        env: { ...process.env, USERPROFILE: home, DSH_INSTALL_TEST_SCRIPT: installer },
        encoding: 'utf8',
        timeout: 30000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const bytes = readFileSync(manifestPath)
      assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
      return JSON.parse(bytes.toString('utf8'))
    }
    const installed = run()
    assert.deepEqual(installed, {
      ...original,
      dsh: { profile: { ...original.dsh.profile, bundles: ['existing-bundle', 'dsh-suggest-actions'] } },
    })
    assert.ok(existsSync(join(target, 'lib/index.js')))
    assert.deepEqual(run(), installed)
    assert.deepEqual(run(true), original)
    assert.equal(existsSync(target), false)
  })
}

if (!windows) test('Windows installer encoding', { skip: 'requires Windows PowerShell' }, () => {})
