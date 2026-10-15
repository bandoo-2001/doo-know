export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function text(value: unknown, label: string, max = 1000000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new HttpError(400, `${label}格式不正确`);
  return value;
}
