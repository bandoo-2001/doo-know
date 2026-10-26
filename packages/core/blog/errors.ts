import { KnowledgeError } from '../knowledge/errors.js';
import { HttpError } from '../errors.js';
const codes: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  413: 'BLOG_LIMIT_EXCEEDED',
  422: 'INVALID_SOURCE',
  503: 'SOURCE_UNAVAILABLE',
};
export class BlogError extends KnowledgeError {
  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(
      status,
      typeof details.code === 'string' ? details.code : codes[status] || 'BLOG_ERROR',
      message,
      status === 503,
      details,
    );
  }
}
export function typedBlogError(error: unknown): never {
  if (error instanceof KnowledgeError) throw error;
  if (error instanceof HttpError)
    throw new BlogError(error.statusCode, error.message, error.details);
  throw error;
}
