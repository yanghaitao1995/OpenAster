// SPDX-License-Identifier: Apache-2.0
import { validateCommandDecision, validateCommandPolicyRequest } from '../core/command-authorization.mjs';

// Routes must remain behind the existing session authentication, Origin and CSRF
// checks. This module never accepts permissions from model/tool arguments.
export function createCommandApprovalService({ runtime }) {
  if (!runtime?.getCommandPolicy || !runtime?.setCommandPolicy || !runtime?.decide) throw new TypeError('Command approval service requires a runtime');
  return Object.freeze({
    read: sessionId => runtime.getCommandPolicy(sessionId),
    update(sessionId, input) { return runtime.setCommandPolicy(sessionId, validateCommandPolicyRequest(input)); },
    decide(approvalId, input) {
      const value = validateCommandDecision(input), { decision, ...options } = value;
      return runtime.decide(approvalId, decision, options);
    },
  });
}
