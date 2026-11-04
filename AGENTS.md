# Repository-wide agent instructions

Before planning, specifying, designing, implementing, reviewing, testing, or
coordinating work, read and enforce [Naming & Identifier Policy](docs/naming-and-identifier-policy.md).
It applies to every agent and every new durable technical identifier, not just
cloud resources. Jira IDs are tracking metadata, never a source of durable names.

Preserve the documented compatibility exceptions. Never rename/recreate an
existing resource, alter its runtime reference, or touch data/volumes to make a
naming check pass. Escalate migrations for explicit approval. Run
`npm run check:naming` and review semantic naming manually; a green static check
does not authorize deployment or certify all identifiers.

All five roles are bound by this shared instruction: **Michael** coordinates
compliance; **Jim** specifies semantic names; **Dwight** enforces naming in
design and exact-head review; **Ryan** implements and regression-tests the
guard; **Pam** verifies policy behavior on the merged code. See the policy's
five-role responsibility table. This tracked file is the repository-wide source
of truth; enforcement must not depend on ignored workstation agent profiles.
