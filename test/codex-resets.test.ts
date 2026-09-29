import assert from "node:assert/strict";
import test from "node:test";
import { parseResetCredits, parseResetOutcome, redeemCodexReset } from "../src/modules/provider/codex-resets.ts";

const origin = "https://chatgpt.com";
function setup() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const notices: string[] = [];
  let confirmed = false;
  const model = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses", baseUrl: `${origin}/backend-api` };
  const ctx: any = {
    model, hasUI: true,
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "oauth-token", baseUrl: `${origin}/backend-api` } }) },
    ui: { notify: (message: string) => notices.push(message), select: async (_: string, choices: string[]) => choices[0],
      confirm: async () => confirmed },
  };
  const stored: any = () => ({ type: "oauth", access: "oauth-token", accountId: "account-id" });
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify(String(input).endsWith("/consume")
      ? { code: "reset", windows_reset: 2 }
      : { available_count: 1, credits: [{ id: "credit-id", status: "available", reset_type: "codex_rate_limits", title: "Saved reset" }] }), { status: 200 });
  };
  return { ctx, stored, calls, notices, fetchFn, confirm: () => { confirmed = true; } };
}

test("Codex reset normalizes credits and validates outcomes", () => {
  assert.deepEqual(parseResetCredits({ available_count: "1", credits: [] }).options.map((x) => x.title), ["Full reset"]);
  assert.throws(() => parseResetCredits({ available_count: -1 }), /count/);
  assert.throws(() => parseResetOutcome({ code: "unknown" }), /outcome/);
});

test("Codex reset never mutates before explicit confirmation", async () => {
  const t = setup();
  assert.equal(await redeemCodexReset(t.ctx, 10, t.fetchFn, t.stored), undefined);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]?.init.method, "GET");
});

test("Codex reset only posts to ChatGPT with matched OAuth and unique id", async () => {
  const t = setup();
  t.confirm();
  assert.equal((await redeemCodexReset(t.ctx, 10, t.fetchFn, t.stored))?.code, "reset");
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1]?.url, `${origin}/backend-api/wham/rate-limit-reset-credits/consume`);
  assert.equal(t.calls[1]?.init.redirect, "manual");
  assert.equal((t.calls[1]?.init.headers as Record<string, string>)["chatgpt-account-id"], "account-id");
  assert.match(String(t.calls[1]?.init.body), /"redeem_request_id":"[0-9a-f-]+"/);
  assert.match(String(t.calls[1]?.init.body), /"credit_id":"credit-id"/);
});

test("Codex reset blocks proxies, API keys and account changes before POST", async () => {
  const t = setup();
  t.ctx.model.baseUrl = "https://proxy.example/v1";
  await assert.rejects(() => redeemCodexReset(t.ctx, 10, t.fetchFn, t.stored), /official/);
  assert.equal(t.calls.length, 0);
  t.ctx.model.baseUrl = `${origin}/backend-api`;
  await assert.rejects(() => redeemCodexReset(t.ctx, 10, t.fetchFn, () => ({ type: "api_key", key: "sk-key" }) as any), /OAuth/);
  t.confirm();
  t.ctx.ui.confirm = async () => { t.ctx.model.id = "other"; return true; };
  await assert.rejects(() => redeemCodexReset(t.ctx, 10, t.fetchFn, t.stored), /changed/);
  assert.equal(t.calls.filter((c) => c.init.method === "POST").length, 0);
});
