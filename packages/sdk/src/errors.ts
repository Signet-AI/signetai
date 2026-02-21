export class SignetError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SignetError";
    this.code = code;
  }
}

export class SignetApiError extends SignetError {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`;
    super(message, "api_error");
    this.name = "SignetApiError";
    this.status = status;
    this.body = body;
  }
}

export class SignetNetworkError extends SignetError {
  override readonly cause: Error;

  constructor(message: string, cause: Error) {
    super(message, "network_error");
    this.name = "SignetNetworkError";
    this.cause = cause;
  }
}

export class SignetTimeoutError extends SignetNetworkError {
  constructor(timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms`,
      new Error("timeout"),
    );
    this.name = "SignetTimeoutError";
  }
}
