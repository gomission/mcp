// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// In-process classifier for wrapped MCP tool calls. The proxy needs to map
// (toolName, args) -> canonical action_class + risk so it can decide block vs
// forward without an HTTP round-trip to a remote classifier.
//
// Mirrors the heuristic in gomission's actionClassRisk() so the proxy's
// decisions stay coherent with the rest of the Trust Graduation surface.
//
// Confidence below CONFIDENCE_FLOOR (0.6) means we matched nothing
// specific -> caller should treat the call as review_required (i.e. block).
// That matches the locked-in design: when classification is unsure, block.

export const CONFIDENCE_FLOOR = 0.6;

// Canonical action classes, mirrored from gomission/src/lib/action-classes.mjs.
// Kept in sync manually until the proxy consumes the neutral @trust-graduation/core registry.
export const ACTION_CLASSES = {
  READ_CONTEXT: "read.context",
  DRAFT_COMPOSE: "draft.compose",
  DRAFT_RESPONSE: "draft.response",
  TOOL_CALL_LOCAL: "tool.call.local",
  EMAIL_SEND_INTERNAL: "email.send.internal",
  EMAIL_SEND_EXTERNAL: "email.send.external",
  CALENDAR_CREATE: "calendar.create",
  SOCIAL_POST_PUBLIC: "social.post.public",
  PAYMENT_INITIATE: "payment.initiate",
  PROPOSAL_SUBMIT: "proposal.submit",
};

// Tokenize a tool name into lowercase word tokens. Handles snake_case,
// kebab-case, dotted.notation, camelCase, and double-underscore (proxy's own
// child__tool form is stripped before tokenization).
export function tokenize(name = "") {
  const cleaned = String(name)
    .replace(/[._\-/\s]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return cleaned.toLowerCase().split(/\s+/).filter(Boolean);
}

// Ordered patterns: first match wins. Each pattern is a set of token-level
// triggers + a set of negative tokens that suppress the match. Per-token
// matching means \b word-boundary regex bugs (underscore is a word char) don't
// bite us on snake_case tool names like `read_file` or `gmail_send_message`.
const PATTERNS = [
  // Money movement and authority changes always sit at the top.
  {
    name: "payment",
    any: ["pay", "payment", "charge", "invoice", "wire", "transfer", "spend", "wallet", "stripe", "plaid"],
    not: [],
    class: ACTION_CLASSES.PAYMENT_INITIATE,
    risk: "critical",
    confidence: 0.95,
  },
  {
    name: "proposal_submit",
    any: ["submit", "file", "filing"],
    requiresAlso: ["proposal", "application", "filing", "legal"],
    not: [],
    class: ACTION_CLASSES.PROPOSAL_SUBMIT,
    risk: "high",
    confidence: 0.9,
  },

  // External communication: tool names like gmail_send_message, send_email,
  // outlook_send. We use the (send + email|mail) intersection to avoid
  // matching "search_email" or "get_emails" as a send action.
  {
    name: "email_external",
    any: ["send", "compose"],
    requiresAlso: ["email", "mail", "gmail", "outlook", "message", "messages", "smtp"],
    not: ["draft", "internal", "search", "read", "list", "get", "fetch"],
    class: ACTION_CLASSES.EMAIL_SEND_EXTERNAL,
    risk: "high",
    confidence: 0.9,
  },

  // Public social posting.
  {
    name: "social_public",
    any: ["tweet", "post"],
    requiresAlso: ["twitter", "linkedin", "facebook", "instagram", "social", "public", "tweet"],
    not: ["draft", "read", "list", "get", "search"],
    class: ACTION_CLASSES.SOCIAL_POST_PUBLIC,
    risk: "high",
    confidence: 0.9,
  },
  // Chat platforms (slack/discord/etc): treat send/post as social.post.public
  // since the proxy can't reason about channel scope.
  {
    name: "chat_send",
    any: ["send", "post"],
    requiresAlso: ["slack", "discord", "telegram", "teams"],
    not: ["draft", "read", "list", "get", "search"],
    class: ACTION_CLASSES.SOCIAL_POST_PUBLIC,
    risk: "high",
    confidence: 0.8,
  },

  // Calendar writes.
  {
    name: "calendar_write",
    any: ["create", "schedule", "send", "invite"],
    requiresAlso: ["calendar", "event", "meeting", "invite"],
    not: ["draft", "read", "list", "get", "search"],
    class: ACTION_CLASSES.CALENDAR_CREATE,
    risk: "high",
    confidence: 0.85,
  },

  // Drafting (safe — does not send).
  {
    name: "draft",
    any: ["draft", "compose", "prepare"],
    not: ["send", "publish"],
    class: ACTION_CLASSES.DRAFT_RESPONSE,
    risk: "low",
    confidence: 0.8,
  },

  // Internal-only email.
  {
    name: "email_internal",
    any: ["send"],
    requiresAlso: ["internal"],
    not: ["external"],
    class: ACTION_CLASSES.EMAIL_SEND_INTERNAL,
    risk: "medium",
    confidence: 0.7,
  },

  // Read-only context reads. read_file, list_files, search_drive, get_event.
  {
    name: "read_context",
    any: ["read", "list", "search", "fetch", "get", "describe", "inspect", "view", "show", "load"],
    not: [],
    class: ACTION_CLASSES.READ_CONTEXT,
    risk: "low",
    confidence: 0.75,
  },
];

function matchPattern(tokens, pattern) {
  const tokenSet = new Set(tokens);
  const anyHit = pattern.any.some((t) => tokenSet.has(t));
  if (!anyHit) return false;
  if (pattern.requiresAlso && !pattern.requiresAlso.some((t) => tokenSet.has(t))) return false;
  if (pattern.not && pattern.not.some((t) => tokenSet.has(t))) return false;
  return true;
}

// Argument-level heuristic: spot common "external recipient" signals.
function argsLookExternal(args = {}) {
  if (!args || typeof args !== "object") return false;
  const externalRecipientKeys = ["to", "recipient", "recipients", "email", "address", "addresses"];
  for (const key of externalRecipientKeys) {
    const value = args[key];
    if (typeof value === "string" && value.includes("@")) return true;
    if (Array.isArray(value) && value.some((v) => typeof v === "string" && v.includes("@"))) return true;
  }
  return false;
}

export function classifyToolCall({ toolName = "", args = {} } = {}) {
  const name = String(toolName || "").toLowerCase();
  if (!name) {
    return { action_class: ACTION_CLASSES.READ_CONTEXT, risk: "low", confidence: 0, reason: "empty tool name" };
  }
  const tokens = tokenize(name);
  for (const pattern of PATTERNS) {
    if (!matchPattern(tokens, pattern)) continue;
    let confidence = pattern.confidence;
    if ((pattern.risk === "high" || pattern.risk === "critical") && argsLookExternal(args)) {
      confidence = Math.min(0.99, confidence + 0.05);
    }
    return {
      action_class: pattern.class,
      risk: pattern.risk,
      confidence,
      reason: `matched ${pattern.name}`,
    };
  }
  // No pattern matched. If args carry an external recipient, escalate to
  // EMAIL_SEND_EXTERNAL as the safer default. Otherwise low-confidence unknown.
  if (argsLookExternal(args)) {
    return {
      action_class: ACTION_CLASSES.EMAIL_SEND_EXTERNAL,
      risk: "high",
      confidence: 0.65,
      reason: "args carry external recipient, no tool-name match",
    };
  }
  return {
    action_class: ACTION_CLASSES.READ_CONTEXT,
    risk: "medium",
    confidence: 0.3,
    reason: "no pattern match; defaulting to unknown",
  };
}

export function shouldBlock(classification) {
  if (!classification) return true;
  if (classification.confidence < CONFIDENCE_FLOOR) return true;
  return classification.risk === "high" || classification.risk === "critical";
}
