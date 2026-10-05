export const SANDBOX_LIMITS = Object.freeze({
  executionMs: 500,
  libraryMs: 5000,
  memoryBytes: 128 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sourceLength: 256 * 1024,
  commandsPerFrame: 1024,
  consoleEntries: 64,
  consoleEntriesPerSecond: 200,
  consoleCharacters: 8000,
  consoleArguments: 32,
  promiseJobs: 1024,
  startupMs: 10000,
  responseMs: 2000,
});

export const CONSOLE_LEVELS = Object.freeze(['log', 'info', 'warn', 'error', 'debug']);
export const CONSOLE_METHODS = Object.freeze([
  ...CONSOLE_LEVELS, 'dir', 'table', 'assert', 'count', 'countReset', 'time', 'timeLog', 'timeEnd',
  'trace', 'group', 'groupCollapsed', 'groupEnd', 'clear',
]);

export function validateConsoleEntries(entries = []) {
  if (!Array.isArray(entries) || entries.length > SANDBOX_LIMITS.consoleEntries || entries.some(entry =>
    !entry || !CONSOLE_LEVELS.includes(entry.level) || typeof entry.message !== 'string' ||
    entry.message.length > SANDBOX_LIMITS.consoleCharacters)) {
    throw new TypeError('Invalid sandbox console output.');
  }
}

export function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > SANDBOX_LIMITS.commandsPerFrame) {
    throw new TypeError('Invalid sandbox command batch.');
  }
  for (const command of commands) {
    if (!Array.isArray(command)) throw new TypeError('Invalid sandbox command.');
    const [name, value] = command;
    if (name === 'fire' && command.length === 1) continue;
    if ((name === 'setAzimuth' || name === 'setElevation') && command.length === 2 && Number.isFinite(value)) continue;
    throw new TypeError('Invalid sandbox command.');
  }
}

export function serializeSandboxError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 100),
    message: String(error?.message || error || 'Unknown script error.').slice(0, 2000),
    line: Number.isInteger(error?.line) && error.line > 0 ? error.line : undefined,
    column: Number.isInteger(error?.column) && error.column > 0 ? error.column : undefined,
  };
}
