// Loaded only through `loadOmpBridge()` in `omp.ts`. The static imports below
// exist in OMP and not in Pi, so a failed import means "not running in OMP".
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { kindOf } from "@oh-my-pi/pi-coding-agent/judgment";
import type { OmpBridge } from "./omp.ts";

const CHAT_COMPLETION_KIND = "online";

export const ompBridge: OmpBridge = {
  roleChain(role, registry) {
    const pool = roleCandidatePool(role, settings, registry);
    // Judge-role chains also hold native judgment and on-device models. They
    // cannot run the classifier's chat completion with a decision tool.
    return resolveRoleChain(role, settings, pool)
      .filter((candidate) => kindOf(candidate) === CHAT_COMPLETION_KIND)
      .map(({ model }) => model);
  },
};
