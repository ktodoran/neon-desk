/**
 * Describes a failed provider response for an error message.
 *
 * Response bodies are untrusted and can echo request data, so the body is
 * never included wholesale. The provider's short machine-readable error code
 * is the exception: it is safe to show and usually names the cause outright
 * ("insufficient_quota", "invalid_api_key", "rate_limit_exceeded").
 */
export async function describeFailure(response: Response): Promise<string> {
  const status = `HTTP ${String(response.status)}`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return status;
  }
  if (typeof body !== 'object' || body === null || !('error' in body)) return status;
  const { error } = body;
  if (typeof error !== 'object' || error === null) return status;

  const candidates = [
    'code' in error ? error.code : undefined,
    'type' in error ? error.type : undefined,
  ];
  const code = candidates.find(
    (value): value is string => typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value),
  );
  return code === undefined ? status : `${status} (${code})`;
}
