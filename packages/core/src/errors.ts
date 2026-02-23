export class AstralformError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "AstralformError";
  }
}

export class AuthenticationError extends AstralformError {
  constructor(message = "Invalid or missing API key") {
    super(message, "authentication_error");
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends AstralformError {
  constructor(message = "Rate limit exceeded") {
    super(message, "rate_limit_error");
    this.name = "RateLimitError";
  }
}

export class LLMNotConfiguredError extends AstralformError {
  constructor(message = "LLM provider not configured for this project") {
    super(message, "llm_not_configured");
    this.name = "LLMNotConfiguredError";
  }
}

export class ServerError extends AstralformError {
  constructor(message = "Internal server error") {
    super(message, "server_error");
    this.name = "ServerError";
  }
}

export class ConnectionError extends AstralformError {
  constructor(message = "Failed to connect to server") {
    super(message, "connection_error");
    this.name = "ConnectionError";
  }
}

export class StreamAbortedError extends AstralformError {
  constructor(message = "Stream was aborted") {
    super(message, "stream_aborted");
    this.name = "StreamAbortedError";
  }
}
