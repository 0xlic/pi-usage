import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "../core/types.ts";
import { snapshotLines } from "./format.ts";
import { safeError } from "../core/security.ts";

/** Open the screen first, then populate each provider as its request finishes. */
export async function showDetails(
  ctx: ExtensionCommandContext,
  providerIds: string[],
  load: (update: (snapshot: UsageSnapshot) => void) => Promise<unknown>,
): Promise<void> {
  const sections = new Map(providerIds.map((id) => [id, `${id} [loading...]`]));
  const snapshots: UsageSnapshot[] = [];
  const lines = () => sections.size ? [...sections.values()].join("\n\n") : "No usage data available.";
  const update = (snapshot: UsageSnapshot) => {
    snapshots.push(snapshot);
    sections.set(snapshot.sourceProviderId, snapshotLines(snapshot).join("\n"));
  };

  if (ctx.mode === "rpc") {
    // RPC has no custom screen. Deliver each provider separately instead of
    // waiting for the slowest request before showing any results in pi-web.
    if (providerIds.length) ctx.ui.notify(`Provider Usage · Loading ${providerIds.join(", ")}...`, "info");
    await load((snapshot) => {
      update(snapshot);
      ctx.ui.notify(snapshotLines(snapshot).join("\n"), snapshot.state === "ok" || snapshot.state === "stale" ? "info" : "warning");
    });
    if (!providerIds.length) ctx.ui.notify(lines(), "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    await load(update);
    ctx.ui.notify(lines(), snapshots.some((item) => item.state === "ok" || item.state === "stale") ? "info" : "warning");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let closed = false;
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Pi Usage · Provider Usage")), 1, 0));
    const body = new Text(lines(), 1, 1);
    container.addChild(body);
    container.addChild(new Text(theme.fg("dim", "Enter/Esc close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Start after custom() has mounted so even slow credential resolution cannot delay the screen.
    setTimeout(() => {
      if (closed) return;
      void load((snapshot) => {
        if (closed) return;
        update(snapshot);
        body.setText([...sections.values()].map((section) => section.split("\n").map((line) => line.startsWith("    ") ? theme.fg("dim", line) : line).join("\n")).join("\n\n"));
        tui.requestRender();
      }).catch((error: unknown) => {
        if (closed) return;
        body.setText(`${lines()}\n\nError: ${safeError(error)}`);
        tui.requestRender();
      });
    }, 0);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
          closed = true;
          done();
        }
      },
    };
  });
}
