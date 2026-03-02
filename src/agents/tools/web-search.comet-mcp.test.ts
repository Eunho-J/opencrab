import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const { createWebSearchTool } = await import("./web-search.js");

function createMockSpawnResult(params: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const mutable = child as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };

  mutable.stdout = stdout;
  mutable.stderr = stderr;
  mutable.kill = vi.fn(() => true);

  queueMicrotask(() => {
    if (params.error) {
      child.emit("error", params.error);
      return;
    }
    if (params.stdout) {
      stdout.write(params.stdout);
    }
    if (params.stderr) {
      stderr.write(params.stderr);
    }
    stdout.end();
    stderr.end();
    child.emit("close", params.code ?? 0);
  });

  return child;
}

describe("web_search comet_mcp provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("runs comet_mcp via mcporter and normalizes results", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        createMockSpawnResult({
          stdout: JSON.stringify({
            content: [{ type: "text", text: "Connected" }],
          }),
        }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnResult({
          stdout: JSON.stringify({
            content: [
              {
                type: "text",
                text: '{"results":[{"title":"Example","url":"https://example.com/article","snippet":"Summary"}]}',
              },
            ],
          }),
        }),
      );

    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "comet_mcp",
              cometMcp: {
                serverName: "comet-bridge",
              },
            },
          },
        },
      },
      sandboxed: true,
    });

    const result = await tool?.execute?.("call-1", { query: "openclaw", count: 1 });
    const details = result?.details as {
      provider?: string;
      results?: Array<{ url?: string; title?: string; description?: string }>;
    };
    const connectArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    const askArgs = spawnMock.mock.calls[1]?.[1] as string[] | undefined;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(connectArgs).toBeDefined();
    expect(askArgs).toBeDefined();
    expect((connectArgs ?? []).join(" ")).toContain("comet-bridge.comet_connect");
    expect((askArgs ?? []).join(" ")).toContain("comet-bridge.comet_ask");
    expect(details.provider).toBe("comet_mcp");
    expect(details.results?.[0]?.url).toBe("https://example.com/article");
    expect(details.results?.[0]?.title).toContain("Example");
    expect(details.results?.[0]?.description).toContain("Summary");
  });

  it("falls back to brave when comet_mcp fails and fallback is enabled", async () => {
    spawnMock.mockImplementationOnce(() =>
      createMockSpawnResult({
        code: 1,
        stderr: "comet failed",
      }),
    );
    vi.stubEnv("BRAVE_API_KEY", "brave-key");

    const fetchMock = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            web: {
              results: [
                {
                  title: "Brave Result",
                  url: "https://example.com/brave",
                  description: "from brave fallback",
                },
              ],
            },
          }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(fetchMock);

    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "comet_mcp",
              cometMcp: {
                fallbackToBrave: true,
              },
            },
          },
        },
      },
      sandboxed: true,
    });

    const result = await tool?.execute?.("call-1", { query: "openclaw fallback" });
    const details = result?.details as {
      provider?: string;
      results?: Array<{ url?: string }>;
    };

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(details.provider).toBe("brave");
    expect(details.results?.[0]?.url).toBe("https://example.com/brave");
  });
});
