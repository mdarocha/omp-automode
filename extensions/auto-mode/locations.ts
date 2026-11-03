import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  GLOBAL_CONFIG_FILE_NAME,
  LOG_DIR_NAME,
  OMP_GLOBAL_DATA_DIR_NAME,
  OMP_PROJECT_DIR,
  PI_GLOBAL_SETTINGS,
  PI_LEGACY_GLOBAL_SETTINGS,
  PI_PROJECT_DIR,
} from "./constants.ts";

export type ConfigRuntime = "pi" | "omp";

/** Where one runtime keeps automode configuration and logs. */
export type ConfigLocations = {
  runtime: ConfigRuntime;
  /** Agent directory reported by omp. Undefined under Pi. */
  agentDir?: string;
  /** Global config path for new installs and the destination of migrations. */
  globalConfigPath: string;
  /** Older global config paths, newest first. They are migrated to `globalConfigPath`. */
  legacyGlobalConfigPaths: string[];
  /** Project config directories relative to the project root, most preferred first. */
  projectConfigDirs: string[];
  /** Log root for sessions without a session directory. Undefined selects the Pi default. */
  logRoot?: string;
};

export const PI_CONFIG_LOCATIONS: ConfigLocations = {
  runtime: "pi",
  globalConfigPath: PI_GLOBAL_SETTINGS[0] ?? "",
  legacyGlobalConfigPaths: [PI_LEGACY_GLOBAL_SETTINGS],
  projectConfigDirs: [PI_PROJECT_DIR],
};

/** Build omp locations below an agent directory. */
export function ompConfigLocations(agentDir: string): ConfigLocations {
  const dataDir = join(agentDir, OMP_GLOBAL_DATA_DIR_NAME);
  const globalConfigPath = join(dataDir, GLOBAL_CONFIG_FILE_NAME);
  return {
    runtime: "omp",
    agentDir,
    globalConfigPath,
    legacyGlobalConfigPaths: [
      ...PI_GLOBAL_SETTINGS,
      PI_LEGACY_GLOBAL_SETTINGS,
    ].filter((path) => path !== globalConfigPath),
    projectConfigDirs: [OMP_PROJECT_DIR, PI_PROJECT_DIR],
    logRoot: join(dataDir, LOG_DIR_NAME),
  };
}

/**
 * Pick config locations for the host runtime. omp exposes its package
 * namespace as `pi.pi`; `getAgentDir()` honours profiles and `PI_CONFIG_DIR`.
 * Any other host, and an omp host whose `getAgentDir()` is unusable, gets the
 * Pi locations.
 */
export function resolveConfigLocations(host: unknown): ConfigLocations {
  const getAgentDir = (host as { pi?: { getAgentDir?: unknown } } | undefined)
    ?.pi?.getAgentDir;
  if (typeof getAgentDir !== "function") {
    return PI_CONFIG_LOCATIONS;
  }
  try {
    const agentDir: unknown = getAgentDir();
    if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
      return PI_CONFIG_LOCATIONS;
    }
    return ompConfigLocations(resolve(agentDir));
  } catch {
    return PI_CONFIG_LOCATIONS;
  }
}

/** The legacy global config to migrate: the first one that exists, else the newest. */
export function selectLegacyGlobalConfigPath(
  locations: ConfigLocations,
): string {
  return locations.legacyGlobalConfigPaths.find((path) => existsSync(path)) ??
    locations.legacyGlobalConfigPaths[0] ??
    PI_LEGACY_GLOBAL_SETTINGS;
}
