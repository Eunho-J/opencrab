import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    issues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
  })),
);
const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailableMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("node:fs", () => ({
  default: fsMock,
  existsSync: fsMock.existsSync,
  readFileSync: fsMock.readFileSync,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("./systemd.js", () => ({
  isSystemdUserServiceAvailable: isSystemdUserServiceAvailableMock,
}));

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}

describe("service-manager-mode", () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    loadConfigMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    writeConfigFileMock.mockReset();
    isSystemdUserServiceAvailableMock.mockReset();

    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReturnValue("");
    loadConfigMock.mockReturnValue({});
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    isSystemdUserServiceAvailableMock.mockResolvedValue(true);
  });

  it("prefers persisted gateway.serviceManagerMode when present", async () => {
    const { resolveLinuxGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    await withPlatform("linux", () => {
      expect(
        resolveLinuxGatewayServiceManagerMode({
          gateway: { serviceManagerMode: "none" },
        }),
      ).toBe("none");
    });
  });

  it("falls back to supervisor mode in containerized linux environments", async () => {
    const { resolveLinuxGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    await withPlatform("linux", () => {
      expect(
        resolveLinuxGatewayServiceManagerMode({}, { container: "docker" } as NodeJS.ProcessEnv),
      ).toBe("supervisor");
    });
  });

  it("defaults to systemd mode on linux when no container hint exists", async () => {
    const { resolveLinuxGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    await withPlatform("linux", () => {
      expect(resolveLinuxGatewayServiceManagerMode({}, {} as NodeJS.ProcessEnv)).toBe("systemd");
    });
  });

  it("maps systemd probe result to detected mode", async () => {
    const { detectLinuxGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    await withPlatform("linux", async () => {
      isSystemdUserServiceAvailableMock.mockResolvedValueOnce(true);
      await expect(detectLinuxGatewayServiceManagerMode()).resolves.toBe("systemd");

      isSystemdUserServiceAvailableMock.mockResolvedValueOnce(false);
      await expect(detectLinuxGatewayServiceManagerMode()).resolves.toBe("supervisor");
    });
  });

  it("persists service manager mode when changed", async () => {
    const { persistGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: { gateway: { mode: "local" } },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const changed = await persistGatewayServiceManagerMode({ mode: "supervisor" });

    expect(changed).toBe(true);
    expect(writeConfigFileMock).toHaveBeenCalledWith({
      gateway: {
        mode: "local",
        serviceManagerMode: "supervisor",
      },
    });
  });

  it("skips writes when persisted mode already matches", async () => {
    const { persistGatewayServiceManagerMode } = await import("./service-manager-mode.js");
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: { gateway: { serviceManagerMode: "systemd" } },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const changed = await persistGatewayServiceManagerMode({ mode: "systemd" });

    expect(changed).toBe(false);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });
});
