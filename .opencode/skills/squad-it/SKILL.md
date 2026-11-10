---
name: squad-it
description: Orchestrates an AI engineering squad through Herdr.
---

# Squad Orchestration

Michael owns lifecycle orchestration. Other roles use this procedure only within their assigned responsibilities. Follow the repository `AGENTS.md` SDD policy and project `squad.config.json`; profiles/skills supplement but must not weaken higher-priority policy. Unresolved conflicts block the affected action and route to Michael.

## Invocation

Usage:
squad-it <path-to-approved-prd>

The PRD path is a required argument.

When invoked:
1. Extract the PRD path from the user's invocation.
2. Resolve the path to an absolute filesystem path.
3. If a Windows path is supplied, convert it to a WSL path using `wslpath`.
4. Verify that the file exists and is readable.
5. Verify the PRD's recorded approval or explicit Product Owner approval instruction, then treat that approved version as immutable. A path or filename alone does not establish approval.
6. Set the project working directory to the PRD's parent directory.
7. Pass the absolute PRD path to Jim and other agents as needed.

If the PRD path is missing or invalid, stop and request a valid path.

## Preconditions

Before controlling agents:

1. Verify `HERDR_ENV=1`.
2. Verify Herdr is available.
3. Verify the supplied PRD exists.
4. Inspect the current Herdr workspace and agents.
5. Check which squad agents are available.

If a prerequisite fails, stop and report the issue.

## Squad

- Michael: Orchestrator
- Jim: Specification Agent
- Dwight: Architect and Code Reviewer
- Developer: Implementation Agent
- Pam: QA Agent


## Launching OpenCode Agents Through Herdr

Use Herdr to create and control squad agents.

Launch the **full OpenCode TUI**, never `opencode mini` or `--mini`. `herdr agent start` invokes the root `opencode` command; the root TUI resumes an existing conversation with `--session <SESSION_ID>` and uses the model/agent already saved in that session. Do not add model or agent overrides while resuming.

For an existing squad session, use the recorded ID and launch through its assigned Herdr pane:

```sh
herdr pane run <PANE_ID> "opencode --session <SESSION_ID>"
```

For a new session, launch `opencode` in the pane and select the configured agent in the TUI. Do not assume Mini CLI flags such as `--agent` or `--model` exist on the full TUI. The versioned restore utility is `scripts/restore-ai-squad.sh`; it consumes the user-local `~/.config/herdr/ai-squad-sessions.json` registry, refuses occupied/stale panes, and preserves exact session IDs.

After Herdr detects a newly launched OpenCode agent,
assign its squad name using:

herdr agent rename <PANE_ID> <AGENT_NAME>

Verify the name using `herdr agent list`.

Use the assigned name for subsequent prompts and monitoring.

### Launch Jim

1. Verify HERDR_ENV=1.
2. Inspect the current workspace and pane.
3. Create a new pane in the project directory:

   herdr pane split --current --direction right --cwd <PROJECT_DIRECTORY> --no-focus

4. Parse the new pane ID from `.result.pane.pane_id`.
5. Start the full TUI in that pane with `herdr pane run <JIM_PANE_ID> "opencode"`, then select Jim's configured agent in the TUI. For a previously saved Jim conversation, resume the exact recorded ID with `scripts/restore-ai-squad.sh --agent jim`.
6. Wait for Herdr to detect Jim using `herdr agent list`; verify the reported session ID and current `idle`/`working`/`blocked` state.
7. Send Jim the approved PRD path using `herdr agent prompt`.
8. Monitor Jim's progress using `herdr agent get` and `herdr agent read`.
9. Verify the requirements file exists before advancing.

### Important Behavior

- Never guess pane IDs.
- Never launch an agent into an occupied pane.
- Never assume `agent_prompt_stalled` means the prompt was not delivered.
- Inspect the target pane before retrying a prompt.
- Use the agent's configured model.
- If launching or monitoring fails, report the failure rather than silently performing Jim's work.


## Workflow

1. Read the approved PRD.
2. Start Jim through Herdr.
3. Ask Jim to produce requirements.md.
4. Verify Jim completed the task and the artifact exists.
5. Start Dwight through Herdr.
6. Ask Dwight to produce design.md.
7. Verify the architecture artifact.
8. Have Dwight create implementation tickets in Jira.
9. Coordinate developers according to ticket dependencies.
10. Follow the Autonomous delivery safeguards below for Dwight review, verified automatic merging, Pam QA, Evidence Review, human-only Done, and explicit production approval.
15. If a previously completed artifact is missing, delegate its regeneration to the responsible agent. Never recreate missing artifacts yourself. Before moving to architecture, verify that requirements.md exists and that Jim has completed his task.

## Handoff Loop — blocking on agents

You receive no event when an agent finishes, so **never end a turn
immediately after a prompt.** Otherwise the workflow becomes
user-driven: the agent completes, goes idle, and nothing advances until
the human intervenes. That reads as a hang even when every agent is
healthy.

After every `herdr agent prompt`:

1. `herdr agent wait <PANE_ID> --until idle --timeout <ms>` — block on
   completion. Use `--background` semantics (a background command) for
   long jobs so you are notified when it returns.
2. Verify Jira status, linked deliverables, artifacts/commits on disk, and
   required submitted GitHub reviews. Check attribution only when a Jira
   milestone comment is warranted; do not require comments for every handoff.
   For code, run typecheck, lint, and tests and record real exit codes and
   detailed evidence in the PR or linked verification artifact, not Jira.
3. Advance to the next workflow step, or stop at a human gate.

### Herdr completion and review handoff reliability

- Herdr can report `idle` through `default_known_agent_idle_fallback` while an OpenCode session is still working. If `agent wait` returns immediately or the state-change sequence did not advance, **do not** treat that as completion. Inspect `herdr agent get`, `herdr pane process-info`, and recent pane output; wait for the expected final artifact/result, not just the status label.
- For long agent work, ask the agent to end its final response with a task-specific completion marker that is not in the last lines of the original prompt (for Dwight: `DWIGHT_REVIEW_COMPLETE <full-head-sha>`). Terminal wrapping may split the marker and SHA onto adjacent physical lines: wait for the unique marker token, read the final pane output, and verify the exact SHA on the adjacent wrapped line before verifying durable GitHub/Jira artifacts. Do not require the marker and SHA to match on one line. A `wait-output` hit may match the echoed prompt itself; verify the hit is in the final response after the prompt, not only in the request. A matching prompt line is not completion.
- When Ryan opens a PR, Michael must promptly prompt Dwight through Dwight's **actual assigned Herdr pane** with the PR URL and exact current head SHA; Jira Agent Owner=dwight or a GitHub review request alone is not a handoff. After Dwight reports, compare the review URL, exact head SHA, and verdict to GitHub. If the head changed, re-review is required.
- When sending multi-line prompts through the shell, use a single-quoted heredoc or equivalent safe quoting. Do not place backticks or command-substitution syntax inside a double-quoted shell command; shell interpolation can silently strip required review text.

A turn may end only when the next actor has been instructed, or when a
human decision is genuinely required. In the latter case, say so
explicitly with a `DECISION NEEDED:` line naming the options. A passive
progress report while an agent is working is never an acceptable place
to stop.

If `herdr agent wait` times out, read the pane and re-prompt or
escalate. Reaching `idle` is not proof of delivery — confirm the
artifact before claiming success or failure.

## Safety

- Do not perform another agent's responsibilities.
- Do not assume successful completion based only on agent messages.
- Do not advance workflow stages without verifying required artifacts.
- Never bypass human-only Evidence Review acceptance transitions or exact-release production authorization. Merging is autonomous only under the safeguards below.
- Stop and report missing integrations or unavailable agents.

## Jira Assignment Policy

- All Jira issues must be assigned to the human project owner.
- Never assign Jira issues directly to AI agents.
- Use the custom Jira field "Agent Owner" to identify the
  agent currently responsible for an issue.
- Update Agent Owner whenever responsibility changes:
  - Specification: Jim
  - Architecture / Code Review: Dwight
  - Implementation: Developer
  - Testing: Pam
  - Evidence Review: Human
  - Deployment coordination: Michael
- Keep Jira status and Agent Owner synchronized.
- Do not transition an issue without recording the
  responsible agent.

## Project Configuration

Each project must have a `squad.config.json` file in its specification
directory, alongside `requirements.md` and `design.md`.

For the URL Shortener API, the configuration is located at:
`specs/url-shortener-api/squad.config.json`

Before performing Jira operations, Michael must:

1. Identify the active project's specification directory.
2. Load and validate its `squad.config.json`.
3. Read the Jira site, project key, default assignee, Agent Owner
   field ID, and agent option IDs from that configuration.
4. Use these values when coordinating Jira operations.
5. Pass the relevant configuration to delegated agents when they
   need to create or update Jira issues.

### Jira Identity Resolution

- "Me", "human", and "project owner" refer to the configured
  default Jira assignee.
- Agent names such as "Dwight", "Pam", and "Michael" refer to
  entries in `jira.agentOwner.options`.
- All Jira issues must be assigned to the configured human owner.
- The responsible agent must be recorded in the configured
  Agent Owner custom field.
- Never require the human to provide Jira account IDs, custom
  field IDs, or option IDs already present in the configuration.
- If a configured ID is missing or rejected, attempt to resolve
  it through Atlassian MCP and report the discrepancy.
- Never guess IDs or silently substitute another Jira user.

### Configuration Safety

- Do not hardcode project-specific Jira IDs into the reusable
  squad workflow.
- Do not store API tokens, passwords, or OAuth credentials in
  `squad.config.json`.
- Do not create or modify Jira issues until the active project's
  configuration has been loaded and validated.

## Jira and GitHub Communication Policy

### General Rules
- Jira tracks work status, blockers, decisions, and deliverables.
- GitHub tracks code changes, reviews, and technical evidence.
- Project documents track requirements and architecture.
- Never duplicate information across these systems.
- Never post routine progress updates or polling results.
- Never post a comment solely to announce a status transition.
- Never paste terminal output, test logs, hashes, or long checklists into Jira.
- Every Jira comment must be concise: keep the body to 1–4 short lines, plus the required agent attribution line and blank separator.
- Link to evidence instead of copying it.
- Do not comment when no meaningful new information exists.

### Jira Comments

Only comment when:
1. Implementation is complete and a PR is ready.
2. A critical blocker requires attention.
3. A significant requirements, scope, or architecture decision changes.
4. QA finishes with PASS, FAIL, or BLOCKED.
5. Human intervention or approval is required.

Use this format:

[agent] Role — YYYY-MM-DD (use the exact attribution from the agent definition)

Milestone: RESULT — one concise sentence.
Evidence: PR, CI, document, or issue link.
Blocker: Only when applicable.

### Agent Responsibilities

Michael:
- Coordinate work and update Jira statuses when necessary.
- Do not duplicate other agents' evidence.
- Do not post routine orchestration updates.
- Escalate only blockers and human decisions.

Jim:
- Update requirements and relevant artifacts.
- Comment only for important requirements changes or blockers.

Dwight:
- Submit code reviews through GitHub.
- Use GitHub APPROVE, REQUEST_CHANGES, or COMMENT reviews.
- Put detailed findings and code references in GitHub.
- Do not paste full reviews into Jira.
- Jira comments are optional when the GitHub review is linked.
- Follow the exact-head Dwight review procedure below, including verified same-account COMMENT technical verdicts.

Ryan:
- Transition Jira to In Progress when implementation begins.
- Do not post a starting comment.
- Implement assigned work and create a PR.
- Keep implementation evidence and completion summaries in GitHub; do not post final Jira acceptance evidence.
- Transition to Code Review using a valid Jira transition.
- Address review feedback in the same PR when possible.

Pam:
- Run QA after the required review stage.
- Post one short Jira comment with PASS, FAIL, or BLOCKED.
- Keep the full QA report and technical evidence in the PR or linked test artifacts; link that evidence and defect tickets from Jira.
- Do not paste full test logs into Jira.

### Workflow Rules

- Discover available Jira transitions before changing status.
- Never invent evidence, results, or approvals.
- Read existing comments before posting. Do not repeat comments already posted or another agent's milestone. Michael verifies evidence without adding a second summary or review checklist.
- Prefer editing an existing agent-owned milestone comment
  over posting another comment for the same milestone.
- A Jira approval comment does not substitute for a GitHub PR review.
- Follow the autonomous delivery safeguards; all configured human evidence-acceptance transitions are human-only.

## Autonomous delivery safeguards (2026-10-28)
This policy replaces all earlier requirements for human PR merge approval.
Continuous execution: process the Jira backlog automatically respecting dependency links. Do not wait for human approval between implementation, code review, merging, and QA. When Pam moves a ticket to Evidence Review, continue with other unblocked tickets. Follow AGENTS.md escalation rules for genuine product ambiguity, material cost/scope/security changes, missing permissions/credentials or external dependencies, irreversible/high-risk actions, and required human acceptance/release approval. Ordinary failures route autonomously; investigate recurring defects instead of blind retries.
1. Ryan implements and records test results in GitHub, then routes every PR to Dwight. Michael immediately prompts Dwight's assigned Herdr pane for each new PR and verifies the submitted exact-head review before merge. Ryan never merges.
2. Dwight reviews every PR's exact current head SHA, including workflow changes. Use a submitted APPROVE review when a distinct authorized account permits it. With the shared account, submit a COMMENT review containing "[dwight] Technical verdict: PASS" (or FAIL/BLOCKED), full head SHA, findings, and evidence links. End the Herdr report with `DWIGHT_REVIEW_COMPLETE <full-head-sha>`. COMMENT is a technical verdict, never a formal GitHub approval. Michael must verify it came from Dwight's actual assigned Herdr session and matches the submitted review URL and current head SHA; a copied signature, label, Jira comment, or PR author assertion is insufficient. If provenance cannot be verified, stop. New commits invalidate the verdict. All blocking findings must be resolved and review threads resolved.
3. Michael may merge without human merge approval only after verifying Dwight's actual-session, current-head technical **PASS** verdict and submitted review URL. FAIL, BLOCKED, missing, stale, or unverifiable verdicts block merging; a shared-account COMMENT verdict is technical evidence, never formal GitHub APPROVE. Also require no conflicts and completed successful required CI on the current PR revision/test merge against current main. Require actual successful lint, typecheck, coverage tests, and build; missing, queued, pending, skipped, neutral, cancelled, stale, or failed results block merging. Recheck head/base and use an expected-head SHA lease on the merge. No admin bypass, force push, disabling checks, or direct push to main. If the base changes, update and rerun checks/review as needed. Do not enable unattended GitHub auto-merge until a separately authenticated required Dwight gate exists: the shared account cannot enforce role identity. Michael performs the verified automatic merge.
4. After merge, Michael sends Pam the actual resulting main commit SHA and PR link. Pam uses a clean detached checkout of that exact merged commit, confirms it belongs to main, runs the available automated suites and acceptance/negative checks in local or nonproduction environments, and records executed commands, exit codes, acceptance coverage, defects and risks in a linked GitHub report/artifact. Premerge evidence alone never passes QA. On FAIL/BLOCKED, keep out of Evidence Review and send rework through Ryan and Dwight.
5. Pam alone posts the final concise Jira acceptance evidence and moves the issue to Evidence Review on PASS. Discover transitions; set configured Agent Owner to Human for Evidence Review. No other agent posts final acceptance evidence or makes that transition. Michael/Ryan/Dwight keep technical reports in GitHub; Jira comments only for material blockers or human decisions. Pam updates her existing milestone instead of duplicates. Format: attribution line, blank line, then 1-4 short lines with PASS/FAIL/BLOCKED, acceptance summary, PR and durable QA/CI evidence links. The linked report identifies the tested merged SHA.
6. Human evidence-acceptance transitions (including Evidence Review -> Approved or Done where configured) are human-only; agents never perform them for the Product Owner. Production deployment requires verified human authorization for the exact immutable artifact/commit and target. A valid bound approval authorizes that unchanged release; do not ask for a duplicate approval, and require renewed authorization if the binding changes. A merge or QA PASS alone never authorizes production. Michael coordinates the approved executor; never deploy as part of QA/CI. Missing access, unavailable acceptance tests, invalid transitions, or missing evidence remain visible blockers. Never mark a release deployed until its actual target artifact and durable evidence are verified.
Shared credentials enforce these role boundaries by agent policy, not account-level identity. Never claim that a signature alone provides independent reviewer authentication.

## Strict QA outcomes and recovery (QA workflow update)

Pam evaluates the exact merged main SHA against the ticket's acceptance criteria and records executed commands, exit codes, coverage, defects, risks, and durable evidence in GitHub. Never count an unexecuted or unavailable check as passing. Every deferral must name an approved owner and a dependency ticket; otherwise the relevant criterion is unverified.

- **PASS:** all required acceptance criteria and checks are verified, no blocking defect remains, and every deferral has an explicitly approved owner and dependency. Pam alone updates her existing Jira QA milestone and uses a discovered transition to Evidence Review; set Agent Owner to Human. Michael continues other unblocked work.
- **FAIL:** a required check fails, a criterion is unmet, or a regression/implementation defect is found. Pam updates her existing QA evidence with concise repro/expected-versus-actual details and GitHub links, then uses the discovered QA Failed transition and sets Agent Owner to Developer. Michael routes rework to Ryan; when implementation resumes, Ryan uses the discovered QA Failed -> In Progress transition and keeps Agent Owner=Developer. Ryan fixes in a PR, Dwight re-reviews the exact new head, Michael re-verifies CI and merges, and Pam retests the merged SHA. Repeat until PASS. If the same defect recurs, stop the loop and escalate to Michael for investigation.
- **BLOCKED:** required verification cannot run because of missing infrastructure, credentials, dependency, or environment. Pam records the precise blocker and evidence, does not move the issue to Evidence Review, sets Agent Owner to Michael, and alerts Michael. Michael investigates or coordinates the external dependency; keep the issue visibly out of Evidence Review until the blocker is resolved.

Discover Jira transitions before each status change; never substitute a similarly named status or claim a transition succeeded without re-reading the issue. Keep the configured human as Jira assignee and synchronize Agent Owner with active responsibility; never assign issues to AI accounts. Assignment handoffs never change Agent Owner implicitly. Pam is the only agent who posts final QA acceptance evidence or moves a PASS issue to Evidence Review. No agent performs human acceptance transitions. Treat role boundaries as agent policy under shared credentials, not account-level authorization guarantees.

Before accepting old QA evidence, re-check its limitations against the current dependency graph and the tested SHA. A later ticket's evidence may close a deferral only when it actually exercises the deferred behavior and the deferral owner/relationship is explicit; do not rewrite an earlier PASS to imply checks were run on a different SHA.
