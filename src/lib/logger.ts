function log(level: "info" | "warn" | "error", objOrMsg: unknown, msg?: string): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (typeof objOrMsg === "string") {
    write(`${prefix} ${objOrMsg}`);
  } else {
    write(`${prefix} ${msg ?? ""}`, objOrMsg);
  }
}

export const logger = {
  info: (objOrMsg: unknown, msg?: string): void => log("info", objOrMsg, msg),
  warn: (objOrMsg: unknown, msg?: string): void => log("warn", objOrMsg, msg),
  error: (objOrMsg: unknown, msg?: string): void => log("error", objOrMsg, msg),
};
