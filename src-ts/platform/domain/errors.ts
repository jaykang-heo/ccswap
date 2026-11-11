/** Exit-coded errors. Mirrors `claude_swap/exceptions.py` exit codes. */

export const EXIT_USAGE = 2;
export const EXIT_UNSUPPORTED = 3;
export const EXIT_INTERRUPTED = 130;

export class CcswapError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CcswapError";
    this.exitCode = exitCode;
  }
}

export class ValidationError extends CcswapError {
  constructor(message: string) {
    super(message, 1);
    this.name = "ValidationError";
  }
}

export class AccountNotFoundError extends CcswapError {
  constructor(message: string) {
    super(message, 1);
    this.name = "AccountNotFoundError";
  }
}

export class ConfigError extends CcswapError {
  constructor(message: string) {
    super(message, 1);
    this.name = "ConfigError";
  }
}

export class UnsupportedCapability extends CcswapError {
  constructor(message: string) {
    super(message, EXIT_UNSUPPORTED);
    this.name = "UnsupportedCapability";
  }
}

export function isInterrupt(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SIGINT"
  );
}
