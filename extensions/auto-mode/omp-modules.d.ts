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
  export function getKnownRoleIds(settings: unknown): string[];
  /** `kind` roles hold non-chat models (image, speech) and the `judge` role. */
  export function getRoleInfo(role: string, settings: unknown): { section: "chat" | "kind" };
}

declare module "@oh-my-pi/pi-coding-agent/modes/model-browser-source" {
  export function createModelBrowserSource(settings: unknown): unknown;
}

declare module "@oh-my-pi/pi-tui/overlays/model-picker" {
  export class ModelPickerComponent {
    constructor(
      tui: unknown,
      source: unknown,
      registry: unknown,
      scopedModels: readonly unknown[],
      callbacks: {
        onPick(model: unknown, selector: string, meta: { overContext: boolean }): void;
        onCancel(): void;
      },
      options?: { currentSelector?: string; selectOnly?: boolean },
    );
    render(width: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
  }
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
  export const settings: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/judgment" {
  type JudgeKind = "native" | "local" | "online";
  type JudgmentResult = {
    provider: string;
    model: string;
    answers: Record<string, { type: string; probabilities?: { yes: number; no: number } }>;
    usage: import("@earendil-works/pi-ai").AssistantMessage["usage"];
  };
  interface Judge {
    judge(
      request: { state: unknown; questions: Record<string, unknown> },
      options?: { signal?: AbortSignal },
    ): Promise<JudgmentResult>;
  }
  export function kindOf(candidate: {
    model: import("@earendil-works/pi-ai").Model<any>;
  }): JudgeKind;
  export function journalJudgmentUsage(manager: unknown): ((usage: unknown) => void) | undefined;
  export function resolveJudge(deps: {
    settings: unknown;
    registry: unknown;
    sessionModel?: import("@earendil-works/pi-ai").Model<any>;
    sessionId?: string;
    purpose: string;
    onUsage?: (usage: unknown) => void;
  }): {
    withCandidate<T>(
      run: (judge: Judge, kind: JudgeKind) => Promise<T>,
      options?: { signal?: AbortSignal },
    ): Promise<T>;
  };
}
