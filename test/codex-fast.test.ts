import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastAvailability, fastPayload, registerCodexFast } from "../src/modules/provider/codex-fast.ts";

const model: any = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };

test("Fast only rewrites supported official Codex requests, never proxies", () => {
  assert.deepEqual(fastPayload({ model: "gpt-5.4", service_tier: "other" }, model, true), { model: "gpt-5.4", service_tier: "priority" });
  assert.deepEqual(fastPayload({ model: "gpt-5.4" }, model, false), { model: "gpt-5.4", service_tier: "default" });
  assert.equal(fastPayload({}, { ...model, baseUrl: "https://proxy.example/v1" }, true), undefined);
  assert.equal(fastPayload({}, { ...model, id: "gpt-6-sol" }, true), undefined);
  assert.equal(fastAvailability({ ...model, id: "gpt-6-sol" }), "gpt-6-sol does not advertise Codex Fast support.");
  assert.equal(fastPayload({}, { ...model, provider: "custom" }, true), undefined);
});

test("/fast persists toggle, refuses invalid config and requires supported model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-fast-"));
  const file = join(dir, "fast.json");
  try {
    const handlers = new Map<string, Function>();
    const notices: string[] = [];
    const pi: any = { registerCommand: (name: string, cmd: any) => handlers.set(name, cmd.handler),
      on: (name: string, fn: Function) => handlers.set(name, fn) };
    const fast = registerCodexFast(pi, () => {}, file);
    const ctx: any = { model, hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
    await handlers.get("session_start")!({}, ctx);
    assert.equal(fast.isEnabled(model), false);
    await handlers.get("fast")!("", ctx);
    assert.equal(fast.isEnabled(model), true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { enabled: true });
    await handlers.get("fast")!("", ctx);
    assert.equal(fast.isEnabled(model), false);
    ctx.model = { ...model, baseUrl: "https://proxy.example/v1" };
    await handlers.get("fast")!("", ctx);
    assert.match(notices.at(-1) ?? "", /proxy/);
    await writeFile(file, "{invalid", "utf8");
    await handlers.get("session_start")!({}, ctx);
    ctx.model = model;
    await handlers.get("fast")!("", ctx);
    assert.match(notices.at(-1) ?? "", /Invalid/);
    assert.equal(await readFile(file, "utf8"), "{invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
