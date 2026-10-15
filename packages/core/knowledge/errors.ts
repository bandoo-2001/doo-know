import { HttpError } from '../errors.js';
export class KnowledgeError extends HttpError {
  constructor(
    status: number,
    public code: string,
    message: string,
    public retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(status, message, details);
  }
}
export function fail(
  status: number,
  code: string,
  message = code,
  retryable = false,
  details: Record<string, unknown> = {},
): never {
  throw new KnowledgeError(status, code, message, retryable, details);
}
