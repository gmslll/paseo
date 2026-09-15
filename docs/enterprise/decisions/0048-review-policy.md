# ADR-0048: Review policy

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A board reads its review policy from `REVIEW.md` front matter in the linked repository's default
branch. The plane stores the parsed result in the board `rp` segment with the source commit.

```yaml
requiredApprovals: 1
allowSelfReview: false
protectedPaths: []
requirePrMerged: false
agentReview:
  enabled: false
  rounds: 1
```

- `needs_review` to `done` requires `requiredApprovals` approve verdicts from reviewers other than
  the assignee unless `allowSelfReview` is true, no changed path matching `protectedPaths` without a
  `task.manage` approval, and a merged pull request when `requirePrMerged` is true.
- A `request_changes` verdict moves the task back to `in_progress` and starts a new review round.
- Agent review runs through the delegation outbox (ADR-0042) with at most 4 rounds. An Agent verdict
  never counts toward `requiredApprovals` and an Agent never moves a task to `done`.
- A missing or invalid `REVIEW.md` uses the defaults above and records the parse error in `rp`.

## Acceptance

Policy tests cover parsing, defaults on invalid input, self-review, protected paths, merged pull
request requirement, and Agent verdict exclusion.
