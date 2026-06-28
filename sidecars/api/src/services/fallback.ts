import { fail } from "../http/envelope";
import type { ApiResponse, ProviderId } from "@mineradio/shared";
import { ProviderNotImplementedError, ProviderError } from "../providers/provider-adapter";

const REDACTED_PROVIDER_ERROR_MESSAGE = "provider error redacted";
const SENSITIVE_AUTH_PATTERNS = [
  /\bMUSIC_U\s*=/i,
  /\b__csrf\s*=/i,
  /\bNMTID\s*=/i,
  /\bqm_keyst\s*=/i,
  /\bqqmusic_key\s*=/i,
  /\bmusic_key\s*=/i,
  /\bwxskey\s*=/i,
  /\bp_skey\s*=/i,
  /\bskey\s*=/i,
  /\bpsrf_qqaccess_token\s*=/i,
  /\bpsrf_qqrefresh_token\s*=/i,
  /\bwxrefresh_token\s*=/i,
  /\bAuthorization\s*:/i,
  /\bCookie\s*:/i,
  /\bSet-Cookie\s*:/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i
];

export function redactErrorMessage(message: string): string {
  const text = String(message ?? "");
  if (SENSITIVE_AUTH_PATTERNS.some(pattern => pattern.test(text))) {
    return REDACTED_PROVIDER_ERROR_MESSAGE;
  }
  return text;
}

export function normalizeError(provider: ProviderId, err: unknown): ApiResponse<never> {
  if (err instanceof ProviderNotImplementedError) {
    return fail({
      code: err.code,
      message: redactErrorMessage(err.message),
      provider: err.provider,
      retryable: err.retryable,
      action: err.action
    });
  }
  if (err instanceof ProviderError) {
    return fail({
      code: err.code,
      message: redactErrorMessage(err.message),
      provider: err.provider,
      retryable: err.retryable,
      action: err.action
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail({
    code: "INTERNAL",
    message: redactErrorMessage(message),
    provider,
    retryable: true
  });
}
