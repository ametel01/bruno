---
name: Agent-actionable issue
about: Define an implementation contract that a builder, checker, and reviewer can execute independently.
title: ""
labels: agent-ready
assignees: ""
---

## Outcome

-

## Completion Contract

- [ ] Expected behavior or process change is explicit and independently checkable.
- [ ] Non-goals and do-not-touch areas are listed.
- [ ] Required local gates and content checks are listed.
- [ ] If a durable progress document requires a commit reference, the builder or coordinator must refresh placeholder wording after an implementation commit, PR head commit, or replacement commit exists.
- [ ] For commit-reference issues, the handoff includes a post-commit or post-PR freshness check before final checker/reviewer handoff.

## Progress Commit References

Use this section only when a durable progress document requires a commit reference. Do not require exact commit references for issues that do not ask for them.

- Builder/coordinator updates placeholder wording after the relevant commit or PR head exists.
- Checker verifies stale placeholder text is absent when a commit reference is required.
- Reviewer verifies the checker evidence and confirms stale placeholder text is absent before merge-readiness.
- Stale placeholder examples to reject: `not available yet` and `builder handoff is uncommitted`.

## Independent Review

- [ ] Builder does not self-approve the work.
- [ ] Checker-agent reruns the required checks and records pass/fail evidence.
- [ ] Maintainer-reviewer evaluates the checked work against this contract before merge-readiness.
