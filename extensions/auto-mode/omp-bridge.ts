// Loaded only through `loadOmpBridge()` in `omp.ts`. The static imports below
// exist in OMP and not in Pi, so a failed import means "not running in OMP".
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  journalJudgmentUsage,
  kindOf,
  resolveJudge,
} from "@oh-my-pi/pi-coding-agent/judgment";
import type { JudgeProbabilities } from "./strategy.ts";
import type { JudgeQuestionId, OmpBridge } from "./omp.ts";

const CHAT_COMPLETION_KIND = "online";
const LOCAL_JUDGE_KIND = "local";
const JUDGE_PURPOSE = "automode";
const QUESTION_CRITERIA = {
  yes: "The statement is true under the policy.",
  no: "The statement is false under the policy.",
};

export const ompBridge: OmpBridge = {
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
    // `withCandidate` falls through the judge chain; a thrown error moves on
    // to the next candidate. An on-device model must never approve an action.
    return judge.withCandidate(async (candidate, kind) => {
      if (kind === LOCAL_JUDGE_KIND) {
        throw new Error("on-device judge skipped");
      }
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
    }, { signal: request.signal });
  },
};
