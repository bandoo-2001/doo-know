/** Git stores this identity in commit objects. Empty settings are valid until a commit is requested. */
export function gitAuthorIssue(name: unknown, email: unknown): 'name' | 'email' | undefined {
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f<>]/.test(name)) return 'name';
  if (typeof email !== 'string' || !/^[^\s<>@\x00-\x1f]+@[^\s<>@\x00-\x1f]+$/.test(email))
    return 'email';
}
