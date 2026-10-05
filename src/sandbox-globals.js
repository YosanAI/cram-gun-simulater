import { CONSOLE_LEVELS } from './sandbox-limits.js';

/** Runs wholly in the guest VM; the captured bridges exchange only bounded text/numbers. */
export function sandboxGlobalsSource(limits) {
  return `
    (function (reserve, write, now) {
      const stringify = JSON.stringify, string = String, Seen = WeakSet, ErrorType = Error;
      const max = ${limits.consoleCharacters};
      function format(value) {
        if (typeof value === "string") return value.slice(0, max);
        if (typeof value === "bigint") return string(value).slice(0, max - 1) + "n";
        if (typeof value === "function") return "[Function]";
        if (value === undefined) return "undefined";
        if (typeof value === "number") return string(value);
        try {
          if (value instanceof ErrorType) return (string(value) + " " + string(value.stack || "")).slice(0, max);
          const seen = new Seen();
          let visited = 0;
          const result = stringify(value, function (key, item) {
            if (++visited > 512) return "[Truncated]";
            if (typeof item === "bigint") return string(item).slice(0, max - 1) + "n";
            if (typeof item === "string") return item.slice(0, max);
            if (item && typeof item === "object") {
              if (seen.has(item)) return "[Circular]";
              seen.add(item);
            }
            return item;
          });
          return result === undefined ? string(value).slice(0, max) : result.slice(0, max);
        } catch { return "[Unserializable]"; }
      }
      const output = {};
      for (const level of ${JSON.stringify(CONSOLE_LEVELS)}) {
        output[level] = function (...args) {
          if (reserve()) write(level, args.slice(0, ${limits.consoleArguments}).map(format).join(" ").slice(0, max));
        };
      }
      output.dir = output.table = output.log;
      output.assert = (condition, ...args) => { if (!condition) output.error("Assertion failed:", ...args); };
      const counts = new Map(), timers = new Map();
      output.count = (label = "default") => { const count = (counts.get(label) || 0) + 1; counts.set(label, count); output.log(label + ":", count); };
      output.countReset = (label = "default") => { counts.delete(label); };
      output.time = (label = "default") => { timers.set(label, now()); };
      output.timeLog = (label = "default", ...args) => { if (timers.has(label)) output.log(label + ":", (now() - timers.get(label)).toFixed(3) + " ms", ...args); };
      output.timeEnd = (label = "default") => { output.timeLog(label); timers.delete(label); };
      output.trace = (...args) => output.debug(...args, new ErrorType("Trace"));
      output.group = output.groupCollapsed = output.log;
      output.groupEnd = output.clear = () => {};
      globalThis.console = output;
      globalThis.performance = { now };
      // Three's default LoadingManager constructs an AbortController at startup.
      // These signals are local JS objects; they provide no network or host access.
      class Signal {
        constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Set(); }
        addEventListener(type, listener) { if (type === "abort") this.listeners.add(listener); }
        removeEventListener(type, listener) { if (type === "abort") this.listeners.delete(listener); }
        throwIfAborted() { if (this.aborted) throw this.reason; }
        static abort(reason) { const controller = new Controller(); controller.abort(reason); return controller.signal; }
        static any(signals) {
          const controller = new Controller();
          for (const signal of signals) {
            if (signal.aborted) { controller.abort(signal.reason); break; }
            signal.addEventListener("abort", () => controller.abort(signal.reason));
          }
          return controller.signal;
        }
      }
      class Controller {
        constructor() { this.signal = new Signal(); }
        abort(reason = new ErrorType("Aborted")) {
          const signal = this.signal;
          if (signal.aborted) return;
          signal.aborted = true; signal.reason = reason;
          const event = { type: "abort", target: signal };
          for (const listener of signal.listeners) {
            if (typeof listener === "function") listener.call(signal, event);
            else listener.handleEvent(event);
          }
          signal.listeners.clear();
          if (signal.onabort) signal.onabort(event);
        }
      }
      globalThis.AbortController = Controller;
      globalThis.AbortSignal = Signal;
      delete globalThis.__reserveConsoleEntry;
      delete globalThis.__writeConsoleEntry;
      delete globalThis.__sandboxNow;
    })(__reserveConsoleEntry, __writeConsoleEntry, __sandboxNow);
  `;
}
