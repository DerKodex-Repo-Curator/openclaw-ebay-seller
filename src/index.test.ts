import { describe, it, expect } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin from "./index.js";

interface ToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
}

function collectTools(): ToolDef[] {
  const meta = getToolPluginMetadata(plugin);
  if (!meta) throw new Error("plugin metadata missing — defineToolPlugin failed?");
  return meta.tools as ToolDef[];
}

describe("plugin surface (S1 — auth)", () => {
  it("has the expected plugin id", () => {
    expect((plugin as { id: string }).id).toBe("tangleclaw-ebay-seller");
  });

  it("registers the three auth tools", () => {
    const names = collectTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "ebay_seller_auth_callback",
      "ebay_seller_auth_start",
      "ebay_seller_auth_status",
    ]);
  });

  it("every tool has a label, a substantial description, and a parameters schema", () => {
    for (const t of collectTools()) {
      expect(t.label, `tool ${t.name} is missing a label`).toBeTruthy();
      expect(
        t.description.length,
        `tool ${t.name} description is too short`
      ).toBeGreaterThan(40);
      expect(t.parameters).toBeTruthy();
    }
  });

  it("manifest contracts.tools exactly matches the registered tools (drift guard)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(here, "..", "openclaw.plugin.json"), "utf8")
    ) as { contracts?: { tools?: string[] } };
    const declared = [...(manifest.contracts?.tools ?? [])].sort();
    const registered = collectTools()
      .map((t) => t.name)
      .sort();
    expect(declared).toEqual(registered);
  });
});
