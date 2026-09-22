// Test-first packing for the AI reviewer’s diff budget.
//
// Root cause of the PR #12 false positives: the diff (~176k chars) was
// concatenated alphabetically and hard-truncated at 50k chars, so
// crawler/test/* — sorted last — was cut before the model ever saw it, and
// the model then reported "the shown diff lacks tests". This packer orders
// test files first so the budget cut lands on source hunks, never on the
// evidence the reviewer needs for coverage claims. Files that don’t fit are
// reported back explicitly so the prompt can tell the model what it didn’t
// see, instead of letting it guess.
export function isTestFile(path) {
  return (
    /(^|\/)(test|tests|__tests__)\//i.test(path) ||
    /\.(test|spec)\.[jt]sx?$/i.test(path)
  );
}

// files: [{ path, chunk }]. Returns { packed, included, omitted }.
export function packDiffFiles(files, maxChars) {
  const tests = files.filter((f) => isTestFile(f.path));
  const src = files.filter((f) => !isTestFile(f.path));
  const ordered = [...tests, ...src];
  const pieces = [];
  const included = [];
  const omitted = [];
  let used = 0;
  for (const f of ordered) {
    const piece = (pieces.length > 0 ? "\n" : "") + f.chunk;
    if (used + piece.length > maxChars) {
      // Nothing fits yet and even the first test file is too big: hard-cut
      // it rather than silently dropping all test evidence.
      if (pieces.length === 0) {
        pieces.push(f.chunk.slice(0, maxChars));
        included.push(f.path);
        used = maxChars;
      } else {
        omitted.push(f.path);
      }
      continue;
    }
    pieces.push(piece);
    included.push(f.path);
    used += piece.length;
  }
  return { packed: pieces.join(""), included, omitted };
}
