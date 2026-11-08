'use strict';

function desktopEnvironment(source) {
  // Filter names before reading values: backend credentials/configuration must
  // not enter the Electron process, including when started by the user's CMD.
  return Object.fromEntries(Object.keys(source)
    .filter((name) => {
      const normalized = name.toUpperCase();
      return normalized !== 'ELECTRON_RUN_AS_NODE'
        && !normalized.startsWith('WEIBIYE_')
        && !normalized.startsWith('OPENAI_')
        && !normalized.startsWith('DEEPSEEK_');
    })
    .map((name) => [name, source[name]]));
}

function stripModelEnvironment(environment) {
  // Directly launched installed executables also drop model settings before
  // creating any UI child process. Do not read values or change user-level env.
  for (const name of Object.keys(environment)) {
    if (/^(?:WEIBIYE_|OPENAI_|DEEPSEEK_)/i.test(name)) delete environment[name];
  }
}

module.exports = { desktopEnvironment, stripModelEnvironment };
