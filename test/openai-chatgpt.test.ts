import assert from "node:assert/strict";
import test from "node:test";
import { openAICodexAdapter } from "../src/modules/provider/adapters/openai-codex.ts";
import { ProviderUsageController } from "../src/modules/provider/controller.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { fastPayload } from "../src/modules/provider/codex-fast.ts";
import { resolveResetAuth } from "../src/modules/provider/codex-resets.ts";

const model: any = { provider: "openai", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const target = { providerId: "openai", model, baseUrl: model.baseUrl, auth: { auth: { apiKey: "new-oauth-token" }, source: "OAuth" } };
const noFetch: typeof fetch = async () => { throw new Error("New OAuth must not call legacy/internal quota endpoints"); };

test("native OpenAI OAuth is recognized without pretending API keys or proxies are subscriptions", () => {
  assert.equal(openAICodexAdapter.canHandle(target), true);
  assert.equal(openAICodexAdapter.canHandle({ ...target, auth: { ...target.auth, source: "stored credential" } }), false);
  assert.equal(openAICodexAdapter.canHandle({ ...target, auth: { ...target.auth, source: "OPENAI_API_KEY" } }), false);
  assert.equal(openAICodexAdapter.canHandle({ ...target, baseUrl: "https://proxy.example/v1" }), false);
  assert.equal(openAICodexAdapter.canHandle({ providerId: "openai-codex" }), true);
});

test("new OpenAI login provides an honest quota limitation and usage link with no network request", async () => {
  const controller = new ProviderUsageController(DEFAULT_CONFIG, noFetch);
  const snapshot = await controller.fetchTarget(target);
  assert.equal(snapshot.state, "empty");
  assert.equal(snapshot.sourceProviderId, "openai");
  assert.equal(snapshot.displayName, "OpenAI (ChatGPT)");
  assert.match(snapshot.summary!, /Quota API unavailable/);
  assert.deepEqual(snapshot.accounts[0]?.metrics, [{ kind: "status", id: "chatgpt-usage-page", label: "View usage", value: "https://chatgpt.com/settings/usage" }]);
  assert.equal(controller.currentView({} as any, snapshot, model), snapshot);
});

test("OpenAI OAuth resolution failures are surfaced rather than reported as incompatible", async () => {
  const snapshot = await new ProviderUsageController(DEFAULT_CONFIG, noFetch).fetchTarget({
    providerId: "openai", baseUrl: model.baseUrl, authError: "OAuth refresh failed",
  });
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.error!, /OAuth refresh failed/);
});

test("all-provider discovery includes configured native OpenAI even without available models", () => {
  const controller = new ProviderUsageController(DEFAULT_CONFIG, noFetch);
  assert.deepEqual(controller.providerIds({ modelRegistry: {
    getAvailable: () => [], getRegisteredProviderIds: () => [],
    getProviderAuthStatus: (id: string) => ({ configured: id === "openai" }),
  } } as any), ["openai"]);
});

test("new OAuth never inherits legacy Fast or reset mutations", async () => {
  assert.equal(fastPayload({}, model, true), undefined);
  await assert.rejects(resolveResetAuth({ model } as any, (() => { throw new Error("Must not read legacy credentials"); }) as any), /official OpenAI Codex model/);
});
