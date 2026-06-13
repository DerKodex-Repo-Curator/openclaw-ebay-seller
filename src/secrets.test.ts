import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentials,
  readUserToken,
  writeUserToken,
  fileModeIsRestrictive,
  expandHome,
  type UserToken,
} from "./secrets.js";
import { homedir } from "node:os";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("expandHome", () => {
  it("expands ~ and ~/ but leaves absolute paths alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/x")).toBe(join(homedir(), "x"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});

describe("readCredentials", () => {
  it("reads a complete credentials file and defaults environment to sandbox", async () => {
    const p = join(dir, "creds.json");
    await writeFile(
      p,
      JSON.stringify({ client_id: "c", cert_id: "s", ru_name: "ru" })
    );
    const creds = await readCredentials(p);
    expect(creds.client_id).toBe("c");
    expect(creds.ru_name).toBe("ru");
    expect(creds.environment).toBe("sandbox");
  });

  it("honors environment=production", async () => {
    const p = join(dir, "creds.json");
    await writeFile(
      p,
      JSON.stringify({
        client_id: "c",
        cert_id: "s",
        ru_name: "ru",
        environment: "production",
      })
    );
    expect((await readCredentials(p)).environment).toBe("production");
  });

  it("throws naming every missing required key", async () => {
    const p = join(dir, "creds.json");
    await writeFile(p, JSON.stringify({ client_id: "c" }));
    await expect(readCredentials(p)).rejects.toThrow(/cert_id, ru_name/);
  });
});

describe("user token read/write", () => {
  const token: UserToken = {
    access_token: "AT",
    refresh_token: "RT",
    token_type: "User Access Token",
    expires_at: new Date(Date.now() + 7200_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 47304000_000).toISOString(),
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    environment: "sandbox",
  };

  it("returns null when the token file is absent", async () => {
    expect(await readUserToken(join(dir, "nope.json"))).toBeNull();
  });

  it("round-trips a token and writes it 0600", async () => {
    const p = join(dir, "token.json");
    await writeUserToken(p, token);
    expect(await readUserToken(p)).toEqual(token);
    const mode = (await stat(p)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions on an existing looser file", async () => {
    const p = join(dir, "token.json");
    await writeFile(p, "{}", { mode: 0o644 });
    await writeUserToken(p, token);
    expect((await stat(p)).mode & 0o077).toBe(0);
  });
});

describe("fileModeIsRestrictive", () => {
  it("true for 0600, false for world-readable, null for missing", async () => {
    const tight = join(dir, "tight");
    const loose = join(dir, "loose");
    await writeFile(tight, "x", { mode: 0o600 });
    await writeFile(loose, "x", { mode: 0o644 });
    expect(await fileModeIsRestrictive(tight)).toBe(true);
    expect(await fileModeIsRestrictive(loose)).toBe(false);
    expect(await fileModeIsRestrictive(join(dir, "missing"))).toBeNull();
  });
});
