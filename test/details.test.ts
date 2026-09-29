import assert from "node:assert/strict";
import test from "node:test";
import { showDetails } from "../src/ui/details.ts";
import type { UsageSnapshot } from "../src/core/types.ts";

const snapshot = (id: string): UsageSnapshot => ({
  adapterId: id, sourceProviderId: id, displayName: id, state: "ok",
  fetchedAt: new Date().toISOString(), accounts: [],
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("details opens with loading rows and updates each provider without waiting for the others", async () => {
  let resolveSlow!: (value: UsageSnapshot) => void;
  const slow = new Promise<UsageSnapshot>((resolve) => { resolveSlow = resolve; });
  let screen: any;
  let renders = 0;
  let close!: () => void;
  const ctx: any = {
    mode: "tui",
    ui: {
      custom: (factory: any) => new Promise<void>((resolve) => {
        close = resolve;
        screen = factory({ requestRender: () => { renders++; } }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
      }),
    },
  };
  const pending = showDetails(ctx, ["fast", "slow"], async (update) => {
    update(snapshot("fast"));
    update(await slow);
  });
  assert.match(screen.render(80).join("\n"), /fast \[loading\.\.\.\]/);
  await tick();
  assert.match(screen.render(80).join("\n"), /fast \[ok\]/);
  assert.match(screen.render(80).join("\n"), /slow \[loading\.\.\.\]/);
  assert.ok(renders > 0);
  resolveSlow(snapshot("slow"));
  await tick();
  assert.match(screen.render(80).join("\n"), /slow \[ok\]/);
  close();
  await pending;
});

test("RPC reports providers as soon as they finish", async () => {
  const messages: string[] = [];
  const ctx: any = { mode: "rpc", ui: { notify: (message: string) => { messages.push(message); } } };
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const pending = showDetails(ctx, ["fast", "slow"], async (update) => {
    update(snapshot("fast"));
    await slow;
    update(snapshot("slow"));
  });
  assert.match(messages[0] ?? "", /Loading/);
  assert.match(messages[1] ?? "", /fast \[ok\]/);
  assert.equal(messages.length, 2);
  release();
  await pending;
  assert.match(messages[2] ?? "", /slow \[ok\]/);
});

test("closing details ignores late results", async () => {
  let update!: (snapshot: UsageSnapshot) => void;
  let screen: any;
  let close!: () => void;
  const ctx: any = { mode: "tui", ui: { custom: (factory: any) => new Promise<void>((resolve) => {
    close = resolve;
    screen = factory({ requestRender: () => { throw new Error("render after close"); } },
      { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
  }) } };
  const pending = showDetails(ctx, ["slow"], async (callback) => { update = callback; });
  await tick();
  screen.handleInput("\u001b");
  await pending;
  update(snapshot("slow"));
  // Closing the screen must not attempt to redraw it.
  assert.ok(close);
});
