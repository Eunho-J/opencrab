import { loadConfig } from "../config/config.js";
import type { GatewayServiceManagerMode } from "../config/types.gateway.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import {
  renderGatewayServiceManagerModeHints,
  resolveLinuxGatewayServiceManagerMode,
} from "./service-manager-mode.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";

function ignoreInstallResult(
  install: (args: GatewayServiceInstallArgs) => Promise<unknown>,
): (args: GatewayServiceInstallArgs) => Promise<void> {
  return async (args) => {
    await install(args);
  };
}

function resolveLinuxServiceManagerModeCached(): GatewayServiceManagerMode {
  try {
    return resolveLinuxGatewayServiceManagerMode(loadConfig(), process.env);
  } catch {
    return resolveLinuxGatewayServiceManagerMode(undefined, process.env);
  }
}

function createExternallyManagedService(mode: GatewayServiceManagerMode): GatewayService {
  const hints = renderGatewayServiceManagerModeHints(mode, process.env);
  const detail =
    hints[0] ??
    `Gateway service manager mode is "${mode}". Use ${process.platform} process supervision.`;
  const unsupported = (action: string) =>
    new Error(`${action} is unavailable when gateway.serviceManagerMode=${mode}. ${detail}`.trim());
  const label = mode === "supervisor" ? "supervisor" : "service manager";
  return {
    label,
    loadedText: "managed",
    notLoadedText: "not managed by OpenClaw",
    install: async () => {
      throw unsupported("Gateway service install");
    },
    uninstall: async () => {
      throw unsupported("Gateway service uninstall");
    },
    stop: async () => {
      throw unsupported("Gateway service stop");
    },
    restart: async () => {
      throw unsupported("Gateway service restart");
    },
    isLoaded: async () => false,
    readCommand: async () => null,
    readRuntime: async () => ({
      status: "unknown",
      detail,
      cachedLabel: true,
    }),
  };
}

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<void>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

export function resolveGatewayService(): GatewayService {
  if (process.platform === "darwin") {
    return {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: ignoreInstallResult(installLaunchAgent),
      uninstall: uninstallLaunchAgent,
      stop: stopLaunchAgent,
      restart: restartLaunchAgent,
      isLoaded: isLaunchAgentLoaded,
      readCommand: readLaunchAgentProgramArguments,
      readRuntime: readLaunchAgentRuntime,
    };
  }

  if (process.platform === "linux") {
    const managerMode = resolveLinuxServiceManagerModeCached();
    if (managerMode !== "systemd") {
      return createExternallyManagedService(managerMode);
    }
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      install: ignoreInstallResult(installSystemdService),
      uninstall: uninstallSystemdService,
      stop: stopSystemdService,
      restart: restartSystemdService,
      isLoaded: isSystemdServiceEnabled,
      readCommand: readSystemdServiceExecStart,
      readRuntime: readSystemdServiceRuntime,
    };
  }

  if (process.platform === "win32") {
    return {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "missing",
      install: ignoreInstallResult(installScheduledTask),
      uninstall: uninstallScheduledTask,
      stop: stopScheduledTask,
      restart: restartScheduledTask,
      isLoaded: isScheduledTaskInstalled,
      readCommand: readScheduledTaskCommand,
      readRuntime: readScheduledTaskRuntime,
    };
  }

  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
