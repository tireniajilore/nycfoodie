// Tests for the two-pass reviewer prompts. These assert the anti-false-
// positive directives survive future edits: check-before-claim on test
// coverage, per-issue evidence, verdict gating, and the negative examples
// from PR #12.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  buildReviewPrompt,
  buildVerifySystemPrompt,
  buildVerifyPrompt,
} from "./ai-review-prompt.mjs";

test("system prompt carries the check-before-claim and evidence rules", () => {
  const p = buildSystemPrompt();
  assert.match(p, /NEVER claim tests are missing/i);
  assert.match(p, /cite file:line and quote the exact/i);
  assert.match(p, /"Needs changes" ONLY/i);
  assert.match(p, /high\/medium\/low confidence/i);
});

test("system prompt includes the PR #12 negative examples", () => {
  const p = buildSystemPrompt();
  assert.match(p, /lacks tests.*truncated|truncated.*lacks tests/i);
  assert.match(p, /does not check res\.ok/i);
});

test("review prompt lists every changed file and discloses omissions", () => {
  const prompt = buildReviewPrompt({
    diff: "DIFF",
    allFiles: ["a.ts", "b.test.ts"],
    omitted: ["c.ts"],
  });
  assert.ok(prompt.includes("- a.ts"));
  assert.ok(prompt.includes("- b.test.ts"));
  assert.ok(prompt.includes("- c.ts"));
  assert.match(prompt, /NOT seen/i);
  assert.ok(prompt.includes("DIFF"));
});

test("review prompt says none omitted when everything fits", () => {
  const prompt = buildReviewPrompt({ diff: "D", allFiles: ["a.ts"], omitted: [] });
  assert.match(prompt, /Omitted from view: none/i);
});

test("verify prompt encodes the kill-rules and returns only the pruned review", () => {
  const v = buildVerifyPrompt({
    draft: "DRAFT",
    diff: "DIFF",
    allFiles: ["a.ts", "a.test.ts"],
    omitted: [],
  });
  assert.match(v, /kill it if/i);
  assert.match(v, /claims tests are missing/i);
  assert.match(v, /Return ONLY the pruned review/i);
  assert.ok(v.includes("DRAFT"));
  assert.match(buildVerifySystemPrompt(), /kill false positives/i);
});
