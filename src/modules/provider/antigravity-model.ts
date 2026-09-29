import type { Metric } from "../../core/types.ts";

/** Match Pi's public Antigravity model IDs to the quota catalog's runtime IDs.
 * Keep these aliases narrowly scoped: never borrow a different model family's pool.
 */
export function antigravityQuotaMetric(metrics: Metric[], publicId: string, thinking?: string): Extract<Metric, { kind: "quota-window" }> | undefined {
  const id = publicId.replace(/^ag-/, "");
  const matches = (candidate: string) => metrics.find(
    (metric): metric is Extract<Metric, { kind: "quota-window" }> => metric.kind === "quota-window" && metric.id === candidate,
  );
  const exact = matches(id);
  if (exact) return exact;
  if (/^gemini-3\.[78]-flash$/.test(id)) return matches(`${id}-tiered`);
  if (/^claude-opus-/.test(id)) return matches(`${id}-thinking`);
  if (id === "gpt-oss-120b") return matches(`${id}-medium`);
  if (/^gemini-3\.1-pro$/.test(id)) return matches(`${id}-${thinking === "high" || thinking === "xhigh" ? "high" : "low"}`);
  if (/^gemini-3\.[56]-flash$/.test(id)) {
    const tier = thinking === "high" || thinking === "xhigh" ? "high" : thinking === "medium" ? "medium" : "low";
    return matches(`${id}-${tier}`);
  }
  return undefined;
}
