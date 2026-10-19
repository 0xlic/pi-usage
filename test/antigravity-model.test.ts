import assert from "node:assert/strict";
import test from "node:test";
import type { Metric, UsageSnapshot } from "../src/core/types.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { antigravityQuotaMetric } from "../src/modules/provider/antigravity-model.ts";
import { ProviderUsageController } from "../src/modules/provider/controller.ts";

const quota = (id: string, remainingFraction = 0.9): Metric => ({
  kind: "quota-window", id, label: id, remainingFraction,
});

for (const family of ["opus", "sonnet"]) {
  const id = `claude-${family}-5-5`;
  const metrics = ["low", "medium", "high"].map((tier) => quota(`${id}-${tier}`));

  test(`Antigravity matches ${id} thinking levels to quota tiers`, () => {
    for (const [thinking, tier] of [
      [undefined, "low"], ["off", "low"], ["minimal", "low"], ["low", "low"],
      ["medium", "medium"], ["high", "high"], ["xhigh", "high"],
    ]) {
      for (const prefix of ["", "ag-"]) {
        assert.equal(antigravityQuotaMetric(metrics, `${prefix}${id}`, thinking)?.id, `${id}-${tier}`);
      }
    }
    assert.equal(antigravityQuotaMetric(metrics, `${id}-medium`, "high")?.id, `${id}-medium`);
    assert.equal(antigravityQuotaMetric(metrics.slice(0, 1), id, "high"), undefined);
    assert.equal(antigravityQuotaMetric(metrics, `claude-${family}-4-6`, "high"), undefined);
  });

  test(`Antigravity status summary displays ${id} quota`, () => {
    const snapshot: UsageSnapshot = {
      adapterId: "antigravity", sourceProviderId: "antigravity", displayName: "Antigravity",
      state: "ok", fetchedAt: "2026-01-01T00:00:00Z",
      accounts: [{ id: "antigravity", provider: "antigravity", label: "Antigravity", metrics }],
    };
    const controller = new ProviderUsageController(DEFAULT_CONFIG);
    const view = controller.currentView({ thinkingLevel: "high" } as any, snapshot, { id } as any);
    assert.equal(view?.state, "ok");
    assert.equal(view?.accounts[0]?.metrics[0]?.id, `${id}-high`);
    assert.match(view?.summary ?? "", /90%/);
  });
}

test("Antigravity preserves exact Claude IDs and legacy Opus thinking aliases", () => {
  const id = "claude-opus-4-6";
  const legacy = quota(`${id}-thinking`);
  assert.equal(antigravityQuotaMetric([legacy], id, "high"), legacy);
  const exact = quota(id, 0.5);
  assert.equal(antigravityQuotaMetric([legacy, quota(`${id}-high`), exact], id, "high"), exact);
  assert.equal(antigravityQuotaMetric([legacy], "claude-sonnet-4-6", "high"), undefined);
});
