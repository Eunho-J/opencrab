import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
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

describe("resolveGatewayService linux mode resolution", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
  });

  it("returns supervisor-backed service when gateway.serviceManagerMode=supervisor", async () => {
    const { resolveGatewayService } = await import("./service.js");
    await withPlatform("linux", async () => {
      loadConfigMock.mockReturnValueOnce({
        gateway: {
          serviceManagerMode: "supervisor",
        },
      });
      const service = resolveGatewayService();
      expect(service.label).toBe("supervisor");
      await expect(
        service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments: ["openclaw", "gateway"],
        }),
      ).rejects.toThrow("gateway.serviceManagerMode=supervisor");
      await expect(service.isLoaded({ env: process.env })).resolves.toBe(false);
    });
  });

  it("returns systemd service when gateway.serviceManagerMode=systemd", async () => {
    const { resolveGatewayService } = await import("./service.js");
    await withPlatform("linux", () => {
      loadConfigMock.mockReturnValueOnce({
        gateway: {
          serviceManagerMode: "systemd",
        },
      });
      const service = resolveGatewayService();
      expect(service.label).toBe("systemd");
    });
  });

  it("falls back to supervisor mode in containerized linux when config is unavailable", async () => {
    const { resolveGatewayService } = await import("./service.js");
    await withPlatform("linux", () => {
      loadConfigMock.mockImplementationOnce(() => {
        throw new Error("invalid config");
      });
      const originalContainer = process.env.container;
      process.env.container = "docker";
      try {
        const service = resolveGatewayService();
        expect(service.label).toBe("supervisor");
      } finally {
        if (originalContainer === undefined) {
          delete process.env.container;
        } else {
          process.env.container = originalContainer;
        }
      }
    });
  });
});
