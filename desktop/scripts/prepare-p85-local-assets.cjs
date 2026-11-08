'use strict';
// Use the Windows drawing implementation with its own module environment.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') throw Error('Windows asset processing required');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1])
    throw Error('Use --output with a new project local-preview directory');
const env = {};
for (const name of Object.keys(process.env))
    if (!/^(?:WEIBIYE_|OPENAI_|DEEPSEEK_|VITE_|PSMODULEPATH$|ELECTRON_RUN_AS_NODE$)/i.test(name))
        env[name] = process.env[name];
const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'prepare-p85-local-assets.ps1'), '-OutputDirectory', args[1]], { env, windowsHide: true, stdio: 'inherit' });
if (result.error) throw Error('Windows asset processor could not start');
process.exitCode = result.status === 0 ? 0 : 1;
