export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const notFound = (resource: string) =>
  new GatewayError(404, "NOT_FOUND", `${resource} was not found.`);

export const invalidRequest = (message: string) => new GatewayError(400, "INVALID_REQUEST", message);

export const conflict = (message: string) => new GatewayError(409, "CONFLICT", message);
