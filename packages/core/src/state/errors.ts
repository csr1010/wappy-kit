/** The state file exists but can't be trusted (unreadable, malformed JSON, or fails schema after migration). */
export class StateCorruptError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StateCorruptError";
  }
}

/** The state file's schemaVersion is newer than this core build understands. Never silently downgrade. */
export class StateVersionTooNewError extends Error {
  constructor(
    public readonly foundVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(
      `state file schemaVersion ${foundVersion} is newer than this @wappy/core build supports (${supportedVersion}); upgrade @wappy/core (and the CLI) before continuing`,
    );
    this.name = "StateVersionTooNewError";
  }
}

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}
