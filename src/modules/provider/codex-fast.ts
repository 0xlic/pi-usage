import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeError } from "../../core/security.ts";

// Conservative allowlist: do not send unsupported tiers to a proxy or an unknown model.
export const FAST_MODELS = new Set(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const FAST_WARNING = "Fast is about 1.5× faster and uses more of your plan allowance.";
export function fastPath(): string { return join(getAgentDir(), "pi-usage", "codex-fast.json"); }

export function fastAvailability(model: Model<Api> | undefined): string | undefined {
  if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return "Fast requires the active official Codex Responses model.";
  try {
    if (new URL(model.baseUrl).origin !== "https://chatgpt.com") return "Fast is not available through a proxy.";
  } catch { return "Fast requires the official ChatGPT endpoint."; }
  if (!FAST_MODELS.has(model.id)) return `${model.id} does not advertise Codex Fast support.`;
  return undefined;
}

export function fastPayload(payload: unknown, model: Model<Api> | undefined, enabled: boolean): unknown | undefined {
  if (fastAvailability(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return { ...payload, service_tier: enabled ? "priority" : "default" };
}

export function registerCodexFast(pi: ExtensionAPI, onChange: (ctx: ExtensionContext) => void = () => {}, path = fastPath()) {
  let enabled = false;
  let invalid = false;
  let generation = 0;
  let pending = Promise.resolve();

  const load = async () => {
    try {
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          typeof (data as Record<string, unknown>).enabled !== "boolean") throw new Error("invalid format");
      enabled = (data as { enabled: boolean }).enabled;
      invalid = false;
    } catch (error) {
      enabled = false;
      invalid = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  };
  const save = async (value: boolean) => {
    if (invalid) throw new Error(`Invalid ${path}; repair it before changing Fast mode.`);
    const file = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(file, `${JSON.stringify({ enabled: value })}\n`, { mode: 0o600, flag: "wx" });
      await rename(file, path);
      enabled = value;
    } finally { await rm(file, { force: true }); }
  };

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode for supported official models",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /fast", "warning"); return; }
      if (!ctx.hasUI) throw new Error("/fast requires TUI or RPC mode.");
      const reason = fastAvailability(ctx.model);
      if (reason) { ctx.ui.notify(reason, "warning"); return; }
      const owner = generation;
      const operation = pending.then(async () => {
        if (owner !== generation) return;
        await save(!enabled);
        if (owner !== generation) return;
        onChange(ctx);
        ctx.ui.notify(enabled ? `Codex Fast enabled. ${FAST_WARNING}` : "Codex Fast disabled; standard routing enabled.", "info");
      });
      pending = operation.catch(() => undefined);
      try { await operation; } catch (error) { ctx.ui.notify(`Could not save Fast mode: ${safeError(error)}`, "error"); }
    },
  });
  pi.on("session_start", async () => {
    generation++;
    await pending;
    await load();
  });
  pi.on("before_provider_request", (event, ctx) => fastPayload(event.payload, ctx.model, enabled));
  pi.on("session_shutdown", async () => { generation++; await pending; });
  return { isEnabled: (model: Model<Api> | undefined) => enabled && !fastAvailability(model) };
}
