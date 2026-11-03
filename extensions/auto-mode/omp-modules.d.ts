// Minimal declarations for the OMP modules loaded by `omp-bridge.ts`. OMP
// provides these at runtime; Pi does not, which is why the bridge is imported
// dynamically. Only the surface the bridge uses is declared.

declare module "@oh-my-pi/pi-coding-agent/config/model-resolver" {
  export function resolveRoleChain(
    role: string,
    settings: unknown,
    pool: Array<import("@earendil-works/pi-ai").Model<any>>,
  ): Array<{
    model: import("@earendil-works/pi-ai").Model<any>;
    explicit: boolean;
  }>;
}

declare module "@oh-my-pi/pi-coding-agent/config/model-roles" {
  export function roleCandidatePool(
    role: string,
    settings: unknown,
    registry: unknown,
  ): Array<import("@earendil-works/pi-ai").Model<any>>;
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
  export const settings: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/judgment" {
  export function kindOf(candidate: {
    model: import("@earendil-works/pi-ai").Model<any>;
  }): "native" | "local" | "online";
}
