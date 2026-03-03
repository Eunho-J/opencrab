import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import type { GatewayServiceManagerMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import { isSystemdUserServiceAvailable } from "./systemd.js";

const GATEWAY_SERVICE_MANAGER_MODES: GatewayServiceManagerMode[] = [
  "systemd",
  "supervisor",
  "none",
];

const GATEWAY_SERVICE_MANAGER_MODE_SET = new Set<GatewayServiceManagerMode>(
  GATEWAY_SERVICE_MANAGER_MODES,
);

export function isGatewayServiceManagerMode(value: unknown): value is GatewayServiceManagerMode {
  return (
    typeof value === "string" &&
    GATEWAY_SERVICE_MANAGER_MODE_SET.has(value as GatewayServiceManagerMode)
  );
}

export function resolveConfiguredGatewayServiceManagerMode(
  cfg: OpenClawConfig | null | undefined,
): GatewayServiceManagerMode | null {
  const raw = cfg?.gateway?.serviceManagerMode;
  if (!isGatewayServiceManagerMode(raw)) {
    return null;
  }
  return raw;
}

function readContainerCgroupHint(): string {
  try {
    return fs.readFileSync("/proc/1/cgroup", "utf8").toLowerCase();
  } catch {
    return "";
  }
}

export function isLikelyContainerizedLinux(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const containerHint = env.container?.trim().toLowerCase();
  if (containerHint && containerHint !== "0" && containerHint !== "false") {
    return true;
  }
  if (fs.existsSync("/.dockerenv")) {
    return true;
  }
  const cgroup = readContainerCgroupHint();
  return (
    cgroup.includes("docker") ||
    cgroup.includes("containerd") ||
    cgroup.includes("kubepods") ||
    cgroup.includes("podman")
  );
}

export function resolveLinuxGatewayServiceManagerMode(
  cfg: OpenClawConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayServiceManagerMode {
  if (process.platform !== "linux") {
    return "none";
  }
  const configured = resolveConfiguredGatewayServiceManagerMode(cfg);
  if (configured) {
    return configured;
  }
  // Legacy configs may not have a persisted mode yet; container detection keeps
  // Docker paths from hard-failing on systemd assumptions.
  return isLikelyContainerizedLinux(env) ? "supervisor" : "systemd";
}

export async function detectLinuxGatewayServiceManagerMode(): Promise<GatewayServiceManagerMode> {
  if (process.platform !== "linux") {
    return "none";
  }
  const available = await isSystemdUserServiceAvailable().catch(() => false);
  return available ? "systemd" : "supervisor";
}

export function renderGatewayServiceManagerModeHints(
  mode: GatewayServiceManagerMode,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (mode === "systemd") {
    return [];
  }
  const runForeground = formatCliCommand("openclaw gateway", env);
  if (mode === "supervisor") {
    return [
      `Gateway service manager mode is "supervisor"; run ${runForeground} under Docker Compose, Kubernetes, or your process supervisor.`,
    ];
  }
  return [
    `Gateway service manager mode is "none"; background service management commands are disabled.`,
    `Run in foreground: ${runForeground}`,
  ];
}

export function applyGatewayServiceManagerMode(
  cfg: OpenClawConfig,
  mode: GatewayServiceManagerMode,
): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      serviceManagerMode: mode,
    },
  };
}

function safeLoadConfigForServiceManagerMode(): OpenClawConfig {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

export async function persistGatewayServiceManagerMode(params: {
  mode: GatewayServiceManagerMode;
  baseConfig?: OpenClawConfig;
}): Promise<boolean> {
  const { mode, baseConfig } = params;
  const snapshot = await readConfigFileSnapshot().catch(() => null);
  if (snapshot?.exists && !snapshot.valid) {
    return false;
  }
  const sourceConfig = baseConfig ?? snapshot?.config ?? safeLoadConfigForServiceManagerMode();
  if (resolveConfiguredGatewayServiceManagerMode(sourceConfig) === mode) {
    return false;
  }
  await writeConfigFile(applyGatewayServiceManagerMode(sourceConfig, mode));
  return true;
}

export async function detectAndPersistLinuxGatewayServiceManagerMode(
  baseConfig?: OpenClawConfig,
): Promise<GatewayServiceManagerMode> {
  const mode = await detectLinuxGatewayServiceManagerMode();
  await persistGatewayServiceManagerMode({ mode, baseConfig }).catch(() => undefined);
  return mode;
}
