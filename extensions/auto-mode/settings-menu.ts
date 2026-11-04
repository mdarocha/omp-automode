import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_REASONING_LEVELS } from "./config.ts";
import { CURRENT_OPTION_MARKER } from "./constants.ts";
import { CLASSIFIER_STRATEGIES, isJudgeConfidence, JUDGE_ROLE } from "./strategy.ts";
import type {
  ClassifierReasoningLevel,
  ClassifierStrategy,
  EffectiveConfig,
  SettingId,
  SettingSource,
  SettingsProvenance,
  SettingUpdate,
} from "./types.ts";

const DONE_OPTION = "Done";
const SESSION_SOURCE_TEXT = "this session (/automode on|off)";
const JUDGE_MODEL_ROW = `Judge model: set in OMP (model role ${JUDGE_ROLE}), not here`;
const JUDGE_MODEL_NOTE =
  `pi-automode has no judge model setting. The hybrid strategy asks OMP's ${JUDGE_ROLE} model role, so assign that role in OMP (modelRoles.${JUDGE_ROLE}).`;

type SettingValue = boolean | number | string | undefined;
type BooleanSettingId = Extract<SettingUpdate, { value: boolean }>["key"];

/** Display order of the editable settings. */
const SETTING_ORDER: readonly SettingId[] = [
  "enabled",
  "classifierStrategy",
  "classifierModel",
  "judgeConfidence",
  "classifierReasoningLevel",
  "log.enabled",
  "log.classifierIo",
];

export const SETTING_LABELS: Record<SettingId, string> = {
  enabled: "enabled",
  classifierStrategy: "classifier strategy",
  classifierModel: "classifier model",
  judgeConfidence: "judge confidence",
  classifierReasoningLevel: "classifier reasoning level",
  "log.enabled": "decision log",
  "log.classifierIo": "classifier I/O log",
};

const SETTING_READERS: Record<SettingId, (config: EffectiveConfig) => SettingValue> = {
  enabled: (config) => config.enabled,
  classifierStrategy: (config) => config.classifierStrategy,
  classifierModel: (config) => config.classifierModel,
  judgeConfidence: (config) => config.judgeConfidence,
  classifierReasoningLevel: (config) => config.classifierReasoningLevel,
  "log.enabled": (config) => config.log.enabled,
  "log.classifierIo": (config) => config.log.classifierIo,
};

const UNSET_TEXT: Partial<Record<SettingId, string>> = {
  classifierModel: "the default",
  classifierReasoningLevel: "unset (provider default)",
};

const SOURCE_TEXT: Record<SettingSource["kind"], string> = {
  default: "default",
  global: "global file",
  "project-local": "project-local file",
  inline: "PI_AUTOMODE_SETTINGS_JSON",
};

const STRATEGY_TEXT: Record<ClassifierStrategy, string> = {
  staged: "staged: one-token gate, then detailed review",
  detailed: "detailed: detailed review only",
  hybrid: "hybrid: OMP judge first, then detailed review (OMP only)",
};

/** What the menu shows and compares: the effective config and where each value comes from. */
export type SettingsSnapshot = {
  /** Includes the per-session `/automode on|off` override. */
  config: EffectiveConfig;
  /** Absent when the config did not come from the settings loader. */
  provenance?: SettingsProvenance;
  /** The per-session `/automode on|off` choice, when one is active. */
  sessionEnabled?: boolean;
};

export type SettingsMenuHost = {
  ctx: ExtensionCommandContext;
  globalConfigPath: string;
  snapshot(): SettingsSnapshot;
  /** One-line classifier description, resolving roles to their models. */
  classifierLabel(): Promise<string>;
  /** Whether OMP's judge is available, which makes the judge-model note relevant. */
  hasJudge: boolean;
  /** Persist an update globally and refresh the live config, reporting the outcome to the user. */
  save(update: SettingUpdate): Promise<void>;
  /** Ask for a classifier model, validate it, and save it. */
  chooseModel(): Promise<void>;
};

export function formatSettingValue(id: SettingId, value: SettingValue): string {
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  return value === undefined ? UNSET_TEXT[id] ?? "unset" : String(value);
}

function describeSource(source: SettingSource, withPath: boolean): string {
  return withPath && source.kind !== "default" && source.kind !== "inline"
    ? `${SOURCE_TEXT[source.kind]} ${source.path}`
    : SOURCE_TEXT[source.kind];
}

type EffectiveSource = { kind: SettingSource["kind"] | "session"; text: string };

function effectiveSource(
  snapshot: SettingsSnapshot,
  id: SettingId,
  withPath: boolean,
): EffectiveSource | undefined {
  if (id === "enabled" && snapshot.sessionEnabled !== undefined) {
    return { kind: "session", text: SESSION_SOURCE_TEXT };
  }
  const source = snapshot.provenance?.[id];
  return source && { kind: source.kind, text: describeSource(source, withPath) };
}

/**
 * Notification text for a saved setting. Says so when a higher-precedence
 * source (project-local file, inline JSON, session choice) keeps another value
 * in effect.
 */
export function describeSavedSetting(
  update: SettingUpdate,
  snapshot: SettingsSnapshot,
): { message: string; overridden: boolean } {
  const { key } = update;
  const saved = `pi-automode ${SETTING_LABELS[key]} saved globally: ${
    formatSettingValue(key, update.value)
  }`;
  const active = SETTING_READERS[key](snapshot.config);
  if (active === update.value) {
    return { message: saved, overridden: false };
  }
  const source = effectiveSource(snapshot, key, true);
  const from = source && source.kind !== "global" && source.kind !== "default"
    ? ` from ${source.text}`
    : "";
  return {
    message: `${saved}, but the current config uses ${
      formatSettingValue(key, active)
    }${from}`,
    overridden: true,
  };
}

async function settingText(
  host: SettingsMenuHost,
  id: SettingId,
): Promise<string> {
  const snapshot = host.snapshot();
  const value = id === "classifierModel"
    ? await host.classifierLabel()
    : formatSettingValue(id, SETTING_READERS[id](snapshot.config));
  const source = effectiveSource(snapshot, id, false);
  const label = SETTING_LABELS[id];
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${value}${
    source ? ` [${source.text}]` : ""
  }`;
}

/** Read-only summary for sessions without a UI. */
export async function describeSettingsWithoutUi(
  host: SettingsMenuHost,
): Promise<string> {
  const lines = await Promise.all(
    SETTING_ORDER.map(async (id) => `  ${await settingText(host, id)}`),
  );
  return [
    "/automode settings needs an interactive UI. Current settings:",
    ...lines,
    `Use /automode on|off for this session or /automode model <provider/id|@role>, or edit ${host.globalConfigPath}.`,
  ].join("\n");
}

async function pickOption<T>(
  ctx: ExtensionCommandContext,
  title: string,
  options: ReadonlyArray<{ label: string; value: T }>,
  current: T,
): Promise<{ value: T } | undefined> {
  const labeled = options.map((option) => ({
    ...option,
    text: option.value === current
      ? `${option.label}${CURRENT_OPTION_MARKER}`
      : option.label,
  }));
  const picked = await ctx.ui.select(title, labeled.map(({ text }) => text));
  const match = labeled.find(({ text }) => text === picked);
  return match && { value: match.value };
}

async function chooseBoolean(
  host: SettingsMenuHost,
  key: BooleanSettingId,
): Promise<void> {
  const picked = await pickOption(
    host.ctx,
    `Set ${SETTING_LABELS[key]}`,
    [{ label: "on", value: true }, { label: "off", value: false }],
    SETTING_READERS[key](host.snapshot().config) === true,
  );
  if (picked) {
    await host.save({ key, value: picked.value });
  }
}

async function chooseStrategy(host: SettingsMenuHost): Promise<void> {
  const picked = await pickOption(
    host.ctx,
    "Set classifier strategy",
    CLASSIFIER_STRATEGIES.map((value) => ({ label: STRATEGY_TEXT[value], value })),
    host.snapshot().config.classifierStrategy,
  );
  if (picked) {
    await host.save({ key: "classifierStrategy", value: picked.value });
  }
}

async function chooseReasoningLevel(host: SettingsMenuHost): Promise<void> {
  const options: Array<{ label: string; value: ClassifierReasoningLevel | undefined }> = [
    { label: "unset: use the provider default", value: undefined },
    ...CLASSIFIER_REASONING_LEVELS.map((value) => ({ label: value, value })),
  ];
  const picked = await pickOption(
    host.ctx,
    "Set classifier reasoning level",
    options,
    host.snapshot().config.classifierReasoningLevel,
  );
  if (picked) {
    await host.save({ key: "classifierReasoningLevel", value: picked.value });
  }
}

async function editJudgeConfidence(host: SettingsMenuHost): Promise<void> {
  const current = host.snapshot().config.judgeConfidence;
  const answer = (await host.ctx.ui.input(
    `Judge confidence: above 0.5 and at most 1 (now ${current})`,
    String(current),
  ))?.trim();
  if (!answer) {
    return;
  }
  const value = Number(answer);
  if (!isJudgeConfidence(value)) {
    host.ctx.ui.notify(
      `Judge confidence must be a number above 0.5 and at most 1, not "${answer}"`,
      "error",
    );
    return;
  }
  await host.save({ key: "judgeConfidence", value });
}

/** Loop over the settings list until the user picks Done or dismisses it. */
export async function runSettingsMenu(host: SettingsMenuHost): Promise<void> {
  for (;;) {
    const rows: Array<{ text: string; run: () => Promise<void> }> = [
      {
        text: await settingText(host, "enabled"),
        run: () => chooseBoolean(host, "enabled"),
      },
      {
        text: await settingText(host, "classifierStrategy"),
        run: () => chooseStrategy(host),
      },
      {
        text: await settingText(host, "classifierModel"),
        run: () => host.chooseModel(),
      },
      {
        text: await settingText(host, "judgeConfidence"),
        run: () => editJudgeConfidence(host),
      },
      ...(host.hasJudge
        ? [{
          text: JUDGE_MODEL_ROW,
          run: async () => host.ctx.ui.notify(JUDGE_MODEL_NOTE, "info"),
        }]
        : []),
      {
        text: await settingText(host, "classifierReasoningLevel"),
        run: () => chooseReasoningLevel(host),
      },
      {
        text: await settingText(host, "log.enabled"),
        run: () => chooseBoolean(host, "log.enabled"),
      },
      {
        text: await settingText(host, "log.classifierIo"),
        run: () => chooseBoolean(host, "log.classifierIo"),
      },
    ];
    const picked = await host.ctx.ui.select(
      `pi-automode settings (saved to ${host.globalConfigPath})`,
      [...rows.map(({ text }) => text), DONE_OPTION],
    );
    const row = rows.find(({ text }) => text === picked);
    if (!row) {
      return;
    }
    await row.run();
  }
}
