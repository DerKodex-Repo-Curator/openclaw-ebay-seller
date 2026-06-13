import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "skills", "ebay-seller", "SKILL.md");

async function skill(): Promise<string> {
  return readFile(skillPath, "utf8");
}

describe("SKILL.md", () => {
  it("exists with frontmatter naming the skill", async () => {
    const s = await skill();
    expect(s.startsWith("---")).toBe(true);
    expect(s).toMatch(/name:\s*ebay-seller/);
  });

  it("teaches the hard-gate workflow: relay summary, WAIT, never self-confirm", async () => {
    const s = await skill().then((x) => x.toLowerCase());
    expect(s).toContain("pending_approval");
    expect(s).toContain("confirm_pending");
    expect(s).toContain("wait");
    // The defining safety instruction: don't self-confirm.
    expect(s).toMatch(/never (call )?(`?ebay_seller_)?confirm_pending|never self-confirm/);
  });

  it("references every hard-gated tool by name", async () => {
    const s = await skill();
    for (const t of [
      "ebay_seller_publish_offer",
      "ebay_seller_withdraw_offer",
      "ebay_seller_update_offer",
      "ebay_seller_confirm_pending",
    ]) {
      expect(s, `SKILL.md must mention ${t}`).toContain(t);
    }
  });

  it("mentions every registered tool somewhere in the decision table", async () => {
    const s = await skill();
    const meta = getToolPluginMetadata(plugin);
    const names = (meta?.tools as { name: string }[]).map((t) => t.name);
    for (const name of names) {
      expect(s, `SKILL.md should document ${name}`).toContain(name);
    }
  });
});
