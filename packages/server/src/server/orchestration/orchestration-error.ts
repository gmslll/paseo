export type OrchestrationErrorCode =
  | "INVALID_OPERATION"
  | "OPERATION_ID_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "CHAIN_DEPTH_EXCEEDED"
  | "AUTHORIZATION_DENIED";

export class OrchestrationError extends Error {
  constructor(
    public readonly code: OrchestrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}
