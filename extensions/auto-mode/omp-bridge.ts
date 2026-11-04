// Loaded only through `loadOmpBridge()` in `omp.ts`. The static imports below
// exist in OMP and not in Pi, so a failed import means "not running in OMP".
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
  getKnownRoleIds,
  getRoleInfo,
  roleCandidatePool,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  journalJudgmentUsage,
  kindOf,
  resolveJudge,
} from "@oh-my-pi/pi-coding-agent/judgment";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { JUDGE_ROLE, type JudgeProbabilities, withCalibratedJudge } from "./strategy.ts";
import type { JudgeQuestionId, OmpBridge } from "./omp.ts";

const CHAT_ROLE_SECTION = "chat";
const CHAT_COMPLETION_KIND = "online";
const JUDGE_PURPOSE = "automode";
const QUESTION_CRITERIA = {
  yes: "The statement is true under the policy.",
  no: "The statement is false under the policy.",
};

export const ompBridge: OmpBridge = {
  roleNames() {
    return getKnownRoleIds(settings).filter((role) =>
      role === JUDGE_ROLE || getRoleInfo(role, settings).section === CHAT_ROLE_SECTION
    );
  },

  pickModel(ctx, currentSelector) {
    return ctx.ui.custom<string | undefined>(
      (tui, _theme, _keybindings, done) =>
        new ModelPickerComponent(
          tui,
          createModelBrowserSource(settings),
          ctx.modelRegistry,
          [],
          { onPick: (_model, selector) => done(selector), onCancel: () => done(undefined) },
          { currentSelector, selectOnly: true },
        ),
      { overlay: true },
    );
  },

  roleChain(role, registry) {
    const pool = roleCandidatePool(role, settings, registry);
    // Judge-role chains also hold native judgment and on-device models. They
    // cannot run the classifier's chat completion with a decision tool.
    return resolveRoleChain(role, settings, pool)
      .filter((candidate) => kindOf(candidate) === CHAT_COMPLETION_KIND)
      .map(({ model }) => model);
  },

  async judge(request) {
    const judge = resolveJudge({
      settings,
      registry: request.registry,
      sessionModel: request.sessionModel,
      sessionId: request.sessionId,
      purpose: JUDGE_PURPOSE,
      onUsage: journalJudgmentUsage(request.sessionManager),
    });
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, { instructions }]) => [id, {
        type: "choice" as const,
        instructions,
        criteria: QUESTION_CRITERIA,
      }]),
    );
    // Only a calibrated (native) candidate may approve; see `withCalibratedJudge`.
    return withCalibratedJudge(judge, async (candidate) => {
      const result = await candidate.judge(
        { state: request.state, questions },
        { signal: request.signal },
      );
      const probabilities = {} as JudgeProbabilities;
      for (const id of Object.keys(request.questions) as JudgeQuestionId[]) {
        const answer = result.answers[id];
        if (answer?.type !== "choice" || answer.probabilities === undefined) {
          throw new Error(`judge answered ${id} with a non-choice answer`);
        }
        probabilities[id] = answer.probabilities.yes;
      }
      return {
        model: `${result.provider}/${result.model}`,
        probabilities,
        usage: result.usage,
      };
    }, request.signal);
  },
};
