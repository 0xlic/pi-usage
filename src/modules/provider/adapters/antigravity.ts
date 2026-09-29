import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metric, UsageAdapter, UsageSnapshot } from "../../../core/types.ts";
import { safeError, sameOriginFetch } from "../../../core/security.ts";
import { compactQuotaSummary } from "../../../ui/format.ts";

const ORIGIN = "https://cloudcode-pa.googleapis.com";
const PATH = "/v1internal:fetchAvailableModels";

interface ModelInfo {
  displayName?: string;
  quotaInfo?: { remainingFraction?: number; resetTime?: string };
}

/** Pi's auth resolver supplies the refreshed access token but may omit OAuth metadata. */
async function localProjectId(providerId: string): Promise<string | undefined> {
  try {
    const auth = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
    const record = auth[providerId];
    if (!record || typeof record !== "object") return undefined;
    const projectId = (record as Record<string, unknown>).projectId;
    return typeof projectId === "string" && projectId.trim() ? projectId : undefined;
  } catch {
    return undefined;
  }
}

export const antigravityAdapter: UsageAdapter = {
  id: "antigravity",
  label: "Antigravity",
  canHandle(target) {
    // Never send credentials for a custom proxy to Google's endpoint.
    return target.providerId.toLowerCase() === "antigravity";
  },
  async fetch({ target, signal, fetchFn }): Promise<UsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const base = { adapterId: this.id, sourceProviderId: target.providerId, displayName: "Antigravity", fetchedAt, accounts: [] };
    const auth = target.auth?.auth as Record<string, unknown> | undefined;
    const token = auth?.apiKey ?? auth?.access;
    if (typeof token !== "string" || !token) {
      return { ...base, state: "unauthorized", error: "No Antigravity access token; run /login antigravity" };
    }
    const projectId = (typeof auth?.projectId === "string" && auth.projectId) ||
      await localProjectId(target.providerId) || process.env.ANTIGRAVITY_PROJECT_ID;
    if (!projectId) {
      return { ...base, state: "unavailable", error: "Antigravity projectId missing; set ANTIGRAVITY_PROJECT_ID or log in again" };
    }

    try {
      const response = await sameOriginFetch(new URL(PATH, ORIGIN), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "antigravity",
        },
        body: JSON.stringify({ project: projectId }),
        signal,
      }, fetchFn, ORIGIN);
      if (response.status === 401 || response.status === 403) {
        return { ...base, state: "unauthorized", error: `Antigravity returned HTTP ${response.status}; log in again` };
      }
      if (!response.ok) throw new Error(`Antigravity returned HTTP ${response.status}`);
      const data = await response.json() as { models?: Record<string, ModelInfo> };
      if (!data.models || typeof data.models !== "object" || Array.isArray(data.models)) {
        return { ...base, state: "incompatible", error: "Antigravity response has no models catalog" };
      }
      const metrics: Metric[] = Object.entries(data.models).flatMap(([id, model]) => {
        const quota = model?.quotaInfo;
        const fraction = quota?.remainingFraction;
        if (typeof fraction !== "number" || !Number.isFinite(fraction)) return [];
        const resetAt = quota?.resetTime && !Number.isNaN(Date.parse(quota.resetTime)) ? quota.resetTime : undefined;
        return [{ kind: "quota-window" as const, id, label: model.displayName || id,
          remainingFraction: Math.min(1, Math.max(0, fraction)), ...(resetAt ? { resetAt } : {}) }];
      });
      const selected = target.model?.id;
      // Only claim an exact model match; never display another model's quota as the current one.
      const currentMetric = selected && metrics.find((metric) => metric.id === selected || metric.id === selected.replace(/^ag-/, ""));
      const summary = currentMetric ? compactQuotaSummary("Antigravity", [currentMetric as Extract<Metric, { kind: "quota-window" }>]) : undefined;
      return {
        ...base,
        state: metrics.length ? "ok" : "empty",
        accounts: [{ id: "antigravity", provider: "antigravity", label: "Antigravity", metrics }],
        ...(summary ? { summary } : {}),
      };
    } catch (error) {
      throw new Error(safeError(error));
    }
  },
};
