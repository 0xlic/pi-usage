import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** IDs created by pi-codex-account; the suffix is user-defined. */
export function isCodexProvider(providerId: string | undefined): boolean {
  return providerId === "openai-codex" ||
    Boolean(providerId && /^openai-codex-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerId));
}

/** Only supplement resolved auth from the same provider and matching token. */
export function resolveCodexUsageAuth(
  providerId: string,
  auth: Record<string, unknown> | undefined,
  stored: typeof readStoredCredential = readStoredCredential,
): { accessToken?: string; accountId?: string } {
  let accessToken = (auth?.apiKey ?? auth?.access) as string | undefined;
  let accountId = (auth?.accountId ?? auth?.chatgpt_account_id) as string | undefined;
  if (!accessToken || !accountId) {
    const credential = stored(providerId);
    if (credential?.type === "oauth" && (!accessToken || accessToken === credential.access)) {
      accessToken ??= credential.access;
      accountId ??= credential.accountId as string | undefined;
    }
  }
  return { ...(accessToken ? { accessToken } : {}), ...(accountId ? { accountId } : {}) };
}
