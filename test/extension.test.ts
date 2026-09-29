import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";

test("extension registers /usage, /fast and /reset commands", () => {
  const commands: string[] = [];
  const pi = {
    registerCommand: (name: string) => { commands.push(name); },
    on: () => undefined,
    getCommands: () => [],
  };
  extension(pi as any);
  assert.deepEqual(commands, ["fast", "usage", "reset"]);
});

test("session startup does not wait for a slow provider request", async () => {
  const handlers = new Map<string, Function[]>();
  let authStarted = false;
  const pi = {
    registerCommand: () => undefined,
    on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getCommands: () => [],
  };
  extension(pi as any);
  const model = { provider: "slow-provider", id: "slow-model", baseUrl: "https://slow.example/v1" };
  const never = new Promise<never>(() => undefined);
  const ctx: any = {
    cwd: process.cwd(), model,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    modelRegistry: {
      getProvider: () => ({ name: "Slow Provider", baseUrl: model.baseUrl }),
      getProviderAuth: () => { authStarted = true; return never; },
      getAll: () => [model],
    },
  };

  // registerCodexFast owns the first session_start handler; the usage lifecycle owns the second.
  const usageStart = handlers.get("session_start")?.[1];
  assert.ok(usageStart);
  await Promise.race([
    usageStart!({}, ctx),
    new Promise((_, reject) => setTimeout(() => reject(new Error("session_start blocked on provider")), 100)),
  ]);
  assert.equal(authStarted, true);

  for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({}, ctx);
});
