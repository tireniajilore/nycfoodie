# Publishing the NYCfoodie skill to ClawHub

The skill package is complete (`SKILL.md` in this folder). Publishing needs
the publisher's own ClawHub account (GitHub OAuth) — it can't be done by an
agent alone. One-time setup, then one command:

```bash
# 1. Install the ClawHub CLI (once)
npm i -g clawhub

# 2. Log in with GitHub (opens a browser window — one tap)
clawhub login
clawhub whoami   # confirms your publisher handle

# 3. Publish (from the repo root)
clawhub skill publish ./skills/nycfoodie \
  --slug nycfoodie \
  --name "NYCfoodie" \
  --version 1.0.0 \
  --changelog "Initial release." \
  --categories location \
  --topics "restaurants,nyc,dining,food,mcp"

# 4. Verify it's live
clawhub inspect nycfoodie
```

Notes:

- `--categories location` matches ClawHub's official category list (AI/ML,
  Utility, Development, Productivity, Web, Science, Media, Social, Finance,
  **Location**, Business). Max 3; one is enough here.
- `--topics`: max 5, ≤48 chars each. No reserved words
  (approved/audited/official/verified/…) — none used.
- Versions are immutable: to update the skill later, bump `--version`
  (e.g. `1.0.1`) and re-run with a changelog.
- Live URL after publish: `https://clawhub.ai/skills/nycfoodie`
  (under your publisher handle).
