#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git diff --cached --quiet; then
  echo "There are already staged changes. Commit or unstage them before running this script." >&2
  exit 1
fi

npm run check
npm test

commit_group() {
  local message="$1"
  shift
  git add -- "$@"
  if ! git diff --cached --quiet; then
    git commit -m "$message"
  fi
}

commit_group "chore: initialize scheduler project and commit guidelines" \
  .gitignore .env.example AGENTS.md package.json scripts/check.js scripts/commit-initial-build.sh

commit_group "feat: add persistent scheduling and prevent overlapping bookings" \
  server/store.js server/scheduling.js tests/scheduling.test.js

commit_group "feat: add private admin credentials and session authentication" \
  server/auth.js scripts/create-admin.js

commit_group "feat: expose booking and admin APIs with access controls" \
  server/api.js server/index.js tests/api.test.js

commit_group "style: add responsive studio design and shared UI utilities" \
  public/styles.css public/shared.js public/favicon.svg public/assets/photo-fallback.svg

commit_group "feat: add studio landing page and filterable gallery" \
  public/pages.js

commit_group "feat: add booking flow and private appointment management" \
  public/booking.js

commit_group "feat: add admin workspace for appointments and studio management" \
  public/admin.js

commit_group "feat: connect application routes and public page navigation" \
  public/index.html public/app.js

commit_group "docs: explain local setup, booking rules, and deployment" \
  README.md

git status --short
git log --oneline -10
