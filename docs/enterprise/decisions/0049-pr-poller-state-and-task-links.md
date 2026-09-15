# ADR-0049: Pull request poller state and task links

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The GitHub service keeps its batched GraphQL polling and host rate pause. It adds persistent state
in `$PASEO_HOME/forge/pr-poller-state.sqlite3`:

- `scopes`: a token bucket of 20 points refilled at 4 per minute per host and account, with
  `frozen_until` so a rate pause survives restart;
- `repo_cooldowns`: per-repository error backoff;
- `targets`: tracked pull requests with task link, tier, last state, head SHA, and next due time;
- `discovery_fingerprints`: branch head checks for task-linked branches without a pull request.

Poll tiers are 20 seconds for tasks in `in_progress` or `needs_review` with a watching client, 300
seconds for other linked pull requests, and 1,200 seconds for discovery. Reference targets join the
existing batch and share its budget. GitLab and Gitea report the capability as unavailable.

Task links:

- a new pull request on a linked Workspace branch records `task.pr_linked`;
- a merge whose head SHA matches the reviewed snapshot, with review policy satisfied, moves the task
  to `done` as the service actor;
- a pull request closed without merge moves the task to `in_progress`.

## Acceptance

Tests cover bucket freezing across restart, repository cooldown, reference targets sharing one
batch, and each task link transition.
