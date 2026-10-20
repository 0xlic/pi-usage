import assert from "node:assert/strict";
import test from "node:test";
import { isCodexProvider, resolveCodexUsageAuth } from "../src/modules/provider/codex-account.ts";
import { openAICodexAdapter } from "../src/modules/provider/adapters/openai-codex.ts";
import { ProviderUsageController } from "../src/modules/provider/controller.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

const ids = ["openai-codex", "openai-codex-work-2", "openai-codex-personal"];

test("Codex aliases support arbitrary valid suffixes and reject unrelated IDs/proxies", () => {
  for (const providerId of ids) {
    assert.equal(isCodexProvider(providerId), true);
    assert.equal(openAICodexAdapter.canHandle({ providerId }), true);
    assert.equal(openAICodexAdapter.canHandle({ providerId, baseUrl: "https://proxy.example/v1" }), false);
  }
  for (const id of [undefined, "openai", "openai-codex-", "openai-codexish"]) {
    assert.equal(isCodexProvider(id), false);
  }
});

test("usage supplements only the exact provider's matching OAuth credential", () => {
  for (const id of ids) {
    const stored: any = (providerId: string) => {
      assert.equal(providerId, id);
      return { type: "oauth", access: `${id}-token`, accountId: `${id}-account` };
    };
    assert.deepEqual(resolveCodexUsageAuth(id, { apiKey: `${id}-token` }, stored), {
      accessToken: `${id}-token`, accountId: `${id}-account`,
    });
    assert.deepEqual(resolveCodexUsageAuth(id, { apiKey: "different-token" }, stored), {
      accessToken: "different-token",
    });
  }
  const stored: any = (id: string) => {
    assert.equal(id, "openai-codex-missing");
    return undefined;
  };
  assert.deepEqual(resolveCodexUsageAuth("openai-codex-missing", undefined, stored), {});
});

test("switching Codex providers uses isolated auth, request headers and snapshots", async () => {
  const calls: Headers[] = [];
  const controller = new ProviderUsageController(DEFAULT_CONFIG, async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: calls.length * 10 } } }));
  });
  const models = ids.map((provider) => ({ provider, id: "gpt-5.4", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }));
  const ctx: any = { modelRegistry: {
    getProvider: (id: string) => ({ name: id }),
    getAll: () => models,
    getProviderAuth: async (id: string) => ({ auth: { apiKey: `${id}-token`, accountId: `${id}-account` }, source: "OAuth" }),
  } };
  for (const model of models) {
    ctx.model = model;
    const snapshot = await controller.refreshCurrent(ctx);
    assert.equal(snapshot?.sourceProviderId, model.provider);
    assert.equal(snapshot?.state, "ok");
    assert.equal(calls.at(-1)?.get("Authorization"), `Bearer ${model.provider}-token`);
    assert.equal(calls.at(-1)?.get("ChatGPT-Account-Id"), `${model.provider}-account`);
  }
  assert.equal(controller.cache.values().length, ids.length);
});
