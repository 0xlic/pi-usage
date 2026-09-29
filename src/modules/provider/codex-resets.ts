import { randomUUID } from "node:crypto";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sameOriginFetch } from "../../core/security.ts";

const ORIGIN = "https://chatgpt.com";
const CREDITS = new URL("/backend-api/wham/rate-limit-reset-credits", ORIGIN);
const CONSUME = new URL(`${CREDITS.pathname}/consume`, ORIGIN);

export interface ResetCredit { id?: string; title: string; description: string; expiresAt?: string }
export interface ResetAvailability { count: number; options: ResetCredit[] }
export interface ResetOutcome { code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; windowsReset: number }
interface ResetAuth { token: string; accountId: string; modelId: string }

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\x00-\x1f\x7f\x1b]/g, " ").slice(0, 160).trim() : fallback;
}

function headerValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[\x20-\x7e]+$/.test(value);
}

/** Fail closed unless the active official Codex account is the Pi OAuth account. */
export async function resolveResetAuth(
  ctx: ExtensionCommandContext,
  stored: typeof readStoredCredential = readStoredCredential,
): Promise<ResetAuth> {
  const model = ctx.model;
  if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses" ||
      !model.baseUrl || new URL(model.baseUrl).origin !== ORIGIN) {
    throw new Error("Usage limit resets require the active official OpenAI Codex model.");
  }
  const credential = stored("openai-codex");
  if (credential?.type !== "oauth" || !headerValue(credential.access) || !headerValue(credential.accountId)) {
    throw new Error("Usage limit resets require Pi's OpenAI Codex OAuth login with an account ID.");
  }
  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id || ctx.model.baseUrl !== model.baseUrl ||
      resolved?.auth.baseUrl && new URL(resolved.auth.baseUrl).origin !== ORIGIN) {
    throw new Error("The active Codex model or effective auth endpoint changed.");
  }
  if (resolved?.auth.apiKey !== credential.access) {
    throw new Error("The active Codex credential does not match Pi's OAuth account.");
  }
  return { token: credential.access, accountId: credential.accountId, modelId: model.id };
}

function unchanged(left: ResetAuth, right: ResetAuth): boolean {
  return left.modelId === right.modelId && left.token === right.token && left.accountId === right.accountId;
}

async function request(url: URL, auth: ResetAuth, signal: AbortSignal, fetchFn: typeof fetch, body?: object): Promise<Record<string, unknown>> {
  const init: RequestInit = {
    method: body ? "POST" : "GET", signal,
    headers: { Authorization: `Bearer ${auth.token}`, "chatgpt-account-id": auth.accountId,
      Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  // A mutation must not be replayed on redirect, even within the same origin.
  const response = body ? await fetchFn(url, { ...init, redirect: "manual" })
    : await sameOriginFetch(url, init, fetchFn, ORIGIN);
  if (!response.ok) throw new Error(`Codex reset endpoint returned HTTP ${response.status}`);
  const json: unknown = await response.json();
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid Codex reset response");
  return json as Record<string, unknown>;
}

export function parseResetCredits(data: Record<string, unknown>): ResetAvailability {
  const rawCount = data.available_count;
  const count = typeof rawCount === "string" && rawCount.trim() ? Number(rawCount) : rawCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Codex reset count");
  if (data.credits !== undefined && !Array.isArray(data.credits)) throw new Error("Invalid Codex reset credits");
  const options: ResetCredit[] = [];
  for (const raw of (data.credits ?? []) as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const credit = raw as Record<string, unknown>;
    if (credit.status !== "available" || credit.reset_type !== "codex_rate_limits") continue;
    if (typeof credit.id !== "string" || !credit.id || credit.id.length > 1024) throw new Error("Invalid Codex reset credit ID");
    const expiresAt = credit.expires_at;
    if (expiresAt != null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))) {
      throw new Error("Invalid Codex reset expiration");
    }
    options.push({ id: credit.id, title: text(credit.title, "Full reset"),
      description: text(credit.description, "Reset current usage limits"),
      ...(typeof expiresAt === "string" ? { expiresAt } : {}) });
  }
  options.sort((a, b) => Date.parse(a.expiresAt ?? "9999-12-31") - Date.parse(b.expiresAt ?? "9999-12-31"));
  const selected = options.slice(0, Math.min(count, 32));
  return { count, options: selected.length ? selected
    : count ? [{ title: "Full reset", description: "Reset current usage limits" }] : [] };
}

export function parseResetOutcome(data: Record<string, unknown>): ResetOutcome {
  if (data.code !== "reset" && data.code !== "nothing_to_reset" && data.code !== "no_credit" && data.code !== "already_redeemed") {
    throw new Error("Unknown Codex reset outcome");
  }
  const rawWindows = data.windows_reset ?? 0;
  const windowsReset = typeof rawWindows === "string" && rawWindows.trim() ? Number(rawWindows) : rawWindows;
  if (typeof windowsReset !== "number" || !Number.isSafeInteger(windowsReset) || windowsReset < 0) throw new Error("Invalid Codex reset outcome");
  return { code: data.code, windowsReset };
}

/** Read-only query; the POST is sent only after an explicit confirmation and account revalidation. */
export async function redeemCodexReset(
  ctx: ExtensionCommandContext,
  timeoutSeconds: number,
  fetchFn: typeof fetch = fetch,
  stored: typeof readStoredCredential = readStoredCredential,
): Promise<ResetOutcome | undefined> {
  if (!ctx.hasUI) throw new Error("/reset requires TUI or RPC confirmation.");
  const initial = await resolveResetAuth(ctx, stored);
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  const availability = parseResetCredits(await request(CREDITS, initial, signal, fetchFn));
  if (!availability.count) {
    ctx.ui.notify("No saved Codex usage limit resets are available.", "info");
    return undefined;
  }
  const options = availability.options;
  // The earliest expiration is first (and therefore the default selection).
  const expiration = (option: ResetCredit) => option.expiresAt
    ? new Date(option.expiresAt).toLocaleString() : "unknown";
  const labels = options.map((option, index) => `${index + 1}. ${option.title} · Expires: ${expiration(option)}`);
  const selected = await ctx.ui.select(`Saved Codex resets (${availability.count} available)`, labels);
  const index = labels.indexOf(selected ?? "");
  if (index < 0) return undefined;
  const option = options[index]!;
  const confirmed = await ctx.ui.confirm("Redeem this saved Codex reset?",
    `${option.title}\nExpires: ${expiration(option)}\n${option.description}\nThis consumes one saved reset for the current Codex account. Continue?`);
  if (!confirmed) return undefined;
  const current = await resolveResetAuth(ctx, stored);
  if (!unchanged(initial, current)) throw new Error("Codex model or account changed; reset not used.");
  const outcome = parseResetOutcome(await request(CONSUME, current, signal, fetchFn,
    { redeem_request_id: randomUUID(), ...(option.id ? { credit_id: option.id } : {}) }));
  return outcome;
}
