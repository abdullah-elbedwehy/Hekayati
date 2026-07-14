export class JobError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode = 409, options?: ErrorOptions) {
    super(code, options);
    this.name = "JobError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
