export const SANDBOX_LIMITS = Object.freeze({
  executionMs: 200,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  sourceLength: 64 * 1024,
  commandsPerFrame: 128,
  startupMs: 10000,
  responseMs: 1000,
});

export function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > SANDBOX_LIMITS.commandsPerFrame) {
    throw new TypeError('Invalid sandbox command batch.');
  }
  for (const command of commands) {
    if (!Array.isArray(command)) throw new TypeError('Invalid sandbox command.');
    const [name, value] = command;
    if (name === 'fire' && command.length === 1) continue;
    if ((name === 'setAzimuth' || name === 'setAltitude') && command.length === 2 && Number.isFinite(value)) continue;
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
