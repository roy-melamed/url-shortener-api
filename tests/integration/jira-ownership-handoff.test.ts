import { expect, it } from 'vitest';
import {
  assignmentStillCurrent,
  OfflineOwnershipPolicy,
  ownershipPolicy as policy,
} from '../../scripts/jira-ownership-policy.ts';
import type { OwnershipSnapshot } from '../../scripts/jira-ownership-policy.ts';

it('fake read-before-edit adapter discards a plan when the issue becomes Approved', () => {
  const current: OwnershipSnapshot = {
    issueId: '990002',
    projectId: '10001',
    issueTypeId: '10008',
    statusId: '10009',
    updatedAt: '2026-01-01T00:01:00.000Z',
    assigneeAccountId: policy.agentsAccountId,
  };
  const engine = new OfflineOwnershipPolicy('2026-01-01T00:00:00.000Z', []);
  const plan = engine.plan(
    {
      eventId: 'fixture-race',
      issueId: current.issueId,
      projectId: current.projectId,
      issueTypeId: current.issueTypeId,
      fromStatusId: '10005',
      toStatusId: current.statusId,
      createdAt: current.updatedAt,
      actorAccountId: policy.agentsAccountId,
    },
    current,
  );
  const reread = { ...current, statusId: '10010', updatedAt: '2026-01-01T00:02:00.000Z' };
  const edits = [];
  if (plan.kind === 'assign' && assignmentStillCurrent(plan, reread)) edits.push(plan.fields);
  expect(plan.kind).toBe('assign');
  expect(edits).toEqual([]);
  expect(reread.assigneeAccountId).toBe(policy.agentsAccountId);
  // Does not close the separate read/write race; no actual Jira CAS is claimed.
});

it.each([undefined, null, { id: 'fixture-developer' }])(
  'synthetic handoff/return preserves Agent Owner verbatim: %j',
  (owner) => {
    const engine = new OfflineOwnershipPolicy('2026-01-01T00:00:00.000Z', []);
    let issue: OwnershipSnapshot = {
      issueId: '990001',
      projectId: '10001',
      issueTypeId: '10008',
      statusId: '10009',
      updatedAt: '2026-01-01T00:01:00.000Z',
      assigneeAccountId: policy.agentsAccountId,
      ...(owner === undefined ? {} : { customfield_10043: owner }),
    };
    const edits: unknown[] = [];
    function simulateTransition(from: string, to: string, time: string, eventId: string) {
      issue = { ...issue, statusId: to, updatedAt: time };
      const plan = engine.plan(
        {
          eventId,
          issueId: issue.issueId,
          projectId: '10001',
          issueTypeId: '10008',
          fromStatusId: from,
          toStatusId: to,
          createdAt: time,
          actorAccountId: policy.humanAccountId,
        },
        issue,
      );
      if (plan.kind === 'assign' && assignmentStillCurrent(plan, issue)) {
        expect(Object.keys(plan.fields)).toEqual(['assignee']);
        edits.push(plan.fields);
        issue = { ...issue, assigneeAccountId: plan.fields.assignee.accountId };
      }
      return plan;
    }
    simulateTransition('10005', '10009', issue.updatedAt, 'fixture-review');
    expect(issue.assigneeAccountId).toBe(policy.humanAccountId);
    simulateTransition('10009', '10005', '2026-01-01T00:02:00.000Z', 'fixture-return');
    expect(issue.assigneeAccountId).toBe(policy.agentsAccountId);
    expect(
      simulateTransition('10009', '10005', '2026-01-01T00:02:00.000Z', 'fixture-return').kind,
    ).toBe('no-op');
    simulateTransition('10005', '10010', '2026-01-01T00:03:00.000Z', 'fixture-approved');
    expect(edits).toHaveLength(2);
    simulateTransition('10010', '10005', '2026-01-01T00:04:00.000Z', 'fixture-reopen');
    expect(edits).toHaveLength(2);
    if (owner === undefined) expect(issue).not.toHaveProperty('customfield_10043');
    else expect(issue.customfield_10043).toBe(owner);
  },
);
