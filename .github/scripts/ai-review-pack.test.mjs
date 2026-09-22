// Tests for the test-first diff packer. Regression target: PR #12, where
// alphabetical concatenation plus a hard 50k truncation cut crawler/test/*
// before the model ever saw it, producing "the shown diff lacks tests".
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestFile, packDiffFiles } from "./ai-review-pack.mjs";

const testChunk = (path) => ({
  path,
  chunk: `diff --git a/${path} b/${path}\n+test content for ${path} `.repeat(20),
});
const srcChunk = (path, size = 1) => ({
  path,
  chunk: `diff --git a/${path} b/${path}\n+src content `.repeat(200 * size),
});

test("isTestFile recognises test dirs and test/spec suffixes", () => {
  for (const p of [
    "crawler/test/fetcher.test.mjs",
    "crawler/tests/x.test.ts",
    "src/__tests__/a.spec.js",
    "foo.spec.ts",
    "bar.test.tsx",
  ]) {
    assert.ok(isTestFile(p), `test file: ${p}`);
  }
  for (const p of [
    "crawler/src/eater/fetcher.ts",
    "src/contest-winners.md",
    "db/migrations/016.sql",
  ]) {
    assert.ok(!isTestFile(p), `not a test file: ${p}`);
  }
});

test("test files pack before source files", () => {
  const files = [
    srcChunk("crawler/src/eater/fetcher.ts"),
    testChunk("crawler/test/fetcher.test.mjs"),
    srcChunk("crawler/src/eater/crawl.ts"),
    testChunk("crawler/test/crawl.test.mjs"),
  ];
  const { packed } = packDiffFiles(files, 100000);
  const firstTest = packed.indexOf("crawler/test/");
  const firstSrc = packed.indexOf("crawler/src/eater/fetcher.ts");
  assert.ok(firstTest !== -1 && firstTest < firstSrc, "tests come first");
});

test("budget cuts land on source hunks, never on test evidence", () => {
  const files = [
    srcChunk("a-huge-src-file.ts", 50), // ~60k chars, won't fit
    testChunk("crawler/test/fetcher.test.mjs"),
    testChunk("crawler/test/crawl.test.mjs"),
  ];
  const { packed, included, omitted } = packDiffFiles(files, 10000);
  assert.ok(
    included.includes("crawler/test/fetcher.test.mjs"),
    "test file kept"
  );
  assert.ok(packed.includes("crawler/test/fetcher.test.mjs"), "in output");
  assert.ok(
    omitted.includes("a-huge-src-file.ts"),
    "oversized src file disclosed as omitted"
  );
});

test("omitted files are disclosed, included files are not", () => {
  const files = [testChunk("t/a.test.mjs"), srcChunk("s/b.ts"), srcChunk("s/c.ts")];
  const { included, omitted } = packDiffFiles(files, 10);
  assert.deepEqual(omitted.sort(), ["s/b.ts", "s/c.ts"].sort());
  assert.ok(!omitted.includes("t/a.test.mjs"));
  assert.ok(included.every((p) => !omitted.includes(p)));
});

test("an oversized first file is hard-cut, not silently dropped", () => {
  const files = [srcChunk("s/huge.ts", 50)];
  const { packed, included, omitted } = packDiffFiles(files, 100);
  assert.equal(packed.length, 100);
  assert.deepEqual(included, ["s/huge.ts"]);
  assert.deepEqual(omitted, []);
});
