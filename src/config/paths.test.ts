import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers OPENCRAB_OAUTH_DIR over OPENCRAB_STATE_DIR", () => {
    const env = {
      OPENCRAB_OAUTH_DIR: "/custom/oauth",
      OPENCRAB_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from OPENCRAB_STATE_DIR when unset", () => {
    const env = {
      OPENCRAB_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectOpenCrabHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.OPENCRAB_HOME;
    if (!configuredHome) {
      throw new Error("OPENCRAB_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".opencrab"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".opencrab", "opencrab.json"));
  }

  it("uses OPENCRAB_STATE_DIR when set", () => {
    const env = {
      OPENCRAB_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses OPENCRAB_HOME for default state/config locations", () => {
    const env = {
      OPENCRAB_HOME: "/srv/opencrab-home",
    } as NodeJS.ProcessEnv;
    expectOpenCrabHomeDefaults(env);
  });

  it("prefers OPENCRAB_HOME over HOME for default state/config locations", () => {
    const env = {
      OPENCRAB_HOME: "/srv/opencrab-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectOpenCrabHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected: string[] = [];
    for (const dir of [".opencrab", ".clawdbot", ".moldbot", ".moltbot"]) {
      expected.push(path.join(resolvedHome, dir, "opencrab.json"));
      expected.push(path.join(resolvedHome, dir, "clawdbot.json"));
      expected.push(path.join(resolvedHome, dir, "moldbot.json"));
      expected.push(path.join(resolvedHome, dir, "moltbot.json"));
    }
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.opencrab when it exists and legacy dir is missing", async () => {
    await withTempRoot("opencrab-state-", async (root) => {
      const newDir = path.join(root, ".opencrab");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.opencrab is missing", async () => {
    await withTempRoot("opencrab-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("opencrab-config-", async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "clawdbot.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("opencrab-config-override-", async (root) => {
      const legacyDir = path.join(root, ".opencrab");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "opencrab.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { OPENCRAB_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "opencrab.json"));
    });
  });
});
