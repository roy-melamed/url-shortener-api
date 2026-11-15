import { describe, expect, it } from 'vitest';
import {
  assignmentStillCurrent,
  OfflineOwnershipPolicy,
  ownershipPolicy as policy,
} from '../../scripts/jira-ownership-policy.ts';

const fence = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:01:00.000Z';
const snapshot = {
  issueId: '990001',
  projectId: '10001',
  issueTypeId: '10008',
  statusId: '10009',
  updatedAt: later,
  assigneeAccountId: policy.agentsAccountId,
  customfield_10043: { id: 'fixture-owner' },
};
const event = {
  eventId: 'fixture-event',
  issueId: snapshot.issueId,
  projectId: '10001',
  issueTypeId: '10008',
  fromStatusId: '10005',
  toStatusId: '10009',
  createdAt: later,
  actorAccountId: policy.agentsAccountId,
};

describe('local ownership policy', () => {
  it('enumerates exact active statuses, never category/name or all non-Evidence statuses', () => {
    expect(policy.activeStatusIds).toEqual(['10004', '10005', '10006', '10007', '10008', '10042']);
    expect(policy.approvedId).toBe('10010');
    expect(policy).not.toHaveProperty('doneId');
  });

  it.each(policy.activeStatusIds)('assigns Agents on entry to active status %s', (statusId) => {
    const decision = new OfflineOwnershipPolicy(fence, []).plan(
      {
        ...event,
        fromStatusId: '10009',
        toStatusId: statusId,
        actorAccountId: policy.humanAccountId,
      },
      { ...snapshot, statusId, assigneeAccountId: policy.humanAccountId },
    );
    expect(decision.kind).toBe('assign');
    if (decision.kind === 'assign')
      expect(decision.fields).toEqual({ assignee: { accountId: policy.agentsAccountId } });
  });

  it('assigns Roy on entry to Evidence Review with only Assignee in payload', () => {
    const decision = new OfflineOwnershipPolicy(fence, []).plan(event, snapshot);
    expect(decision.kind).toBe('assign');
    if (decision.kind !== 'assign') throw new Error('fixture-plan-missing');
    expect(decision.fields).toEqual({ assignee: { accountId: policy.humanAccountId } });
    expect(Object.keys(decision.fields)).toEqual(['assignee']);
    expect(Object.isFrozen(decision.fields.assignee)).toBe(true);
    expect(assignmentStillCurrent(decision, snapshot)).toBe(true);
    expect(assignmentStillCurrent(decision, { ...snapshot, customfield_10043: undefined })).toBe(
      true,
    );
  });

  it('requires exact Roy account on Evidence Review return, not signatures or Agents', () => {
    const current = { ...snapshot, statusId: '10005', assigneeAccountId: policy.humanAccountId };
    const returned = { ...event, fromStatusId: '10009', toStatusId: '10005' };
    expect(new OfflineOwnershipPolicy(fence, []).plan(returned, current)).toEqual({
      kind: 'no-op',
      reason: 'return-not-by-human',
    });
    expect(
      new OfflineOwnershipPolicy(fence, []).plan(
        { ...returned, actorAccountId: policy.humanAccountId },
        current,
      ).kind,
    ).toBe('assign');
    // This is account matching, not proof that a credential is exclusively human-controlled.
  });

  it.each(['10010', '10011', '99999'])(
    'never assigns protected/inactive/unknown status %s',
    (statusId) => {
      expect(
        new OfflineOwnershipPolicy(fence, []).plan(
          { ...event, toStatusId: statusId },
          { ...snapshot, statusId },
        ).kind,
      ).toBe('no-op');
    },
  );

  it('protects Approved baseline records even after reopening, with no bootstrap assignments', () => {
    const engine = new OfflineOwnershipPolicy(fence, [
      { ...snapshot, statusId: '10010', updatedAt: fence },
    ]);
    expect(engine.plan(event, snapshot)).toEqual({ kind: 'no-op', reason: 'protected-approved' });
    expect(
      new OfflineOwnershipPolicy(fence, []).plan({ ...event, fromStatusId: '10010' }, snapshot)
        .kind,
    ).toBe('no-op');
  });

  it('remembers currently observed Approved records for the local session', () => {
    const engine = new OfflineOwnershipPolicy(fence, []);
    expect(
      engine.plan({ ...event, toStatusId: '10010' }, { ...snapshot, statusId: '10010' }).kind,
    ).toBe('no-op');
    expect(engine.plan(event, snapshot)).toEqual({ kind: 'no-op', reason: 'protected-approved' });
  });

  it('rejects old/equal-fence events, duplicate events, non-transitions and already assigned targets', () => {
    const engine = new OfflineOwnershipPolicy(fence, []);
    for (const createdAt of [fence, '2025-12-31T23:59:59.000Z']) {
      expect(engine.plan({ ...event, createdAt }, { ...snapshot, updatedAt: createdAt }).kind).toBe(
        'no-op',
      );
    }
    expect(engine.plan(event, snapshot).kind).toBe('assign');
    expect(engine.plan(event, snapshot).kind).toBe('no-op');
    expect(
      engine.plan(
        { ...event, createdAt: '2026-01-01T00:02:00.000Z' },
        { ...snapshot, updatedAt: '2026-01-01T00:02:00.000Z' },
      ),
    ).toEqual({ kind: 'no-op', reason: 'duplicate-event' });
    expect(
      new OfflineOwnershipPolicy(fence, []).plan({ ...event, fromStatusId: '10009' }, snapshot),
    ).toEqual({ kind: 'no-op', reason: 'not-a-transition' });
    expect(
      new OfflineOwnershipPolicy(fence, []).plan(event, {
        ...snapshot,
        assigneeAccountId: policy.humanAccountId,
      }),
    ).toEqual({ kind: 'no-op', reason: 'already-assigned' });
    expect(
      new OfflineOwnershipPolicy(fence, []).plan(event, { ...snapshot, assigneeAccountId: null })
        .kind,
    ).toBe('assign');
  });

  it('rejects stale status, timestamp, issue, type and ordering', () => {
    for (const patch of [
      { statusId: '10005' },
      { updatedAt: fence },
      { issueId: '990002' },
      { issueTypeId: '10009' },
    ]) {
      expect(
        new OfflineOwnershipPolicy(fence, []).plan(event, { ...snapshot, ...patch }).kind,
      ).toBe('no-op');
    }
    const engine = new OfflineOwnershipPolicy(later, [{ ...snapshot, updatedAt: later }]);
    expect(engine.plan(event, snapshot).kind).toBe('no-op');
    expect(
      new OfflineOwnershipPolicy(fence, []).plan({ ...event, fromStatusId: '99999' }, snapshot)
        .kind,
    ).toBe('no-op');
  });

  it.each([
    null,
    {},
    [],
    { ...event, projectId: '99999' },
    { ...event, actorAccountId: '' },
    { ...event, actorAccountId: null },
    { ...event, issueTypeId: '99999' },
    { ...event, createdAt: 'not-time' },
    { ...event, toStatusId: 10009 },
    { ...event, eventId: 'secret\ntext' },
    { ...event, displayName: 'Roy' },
  ])('fails closed on malformed events %#', (bad) => {
    expect(new OfflineOwnershipPolicy(fence, []).plan(bad, snapshot)).toEqual({
      kind: 'no-op',
      reason: 'invalid-input',
    });
  });

  it.each([
    null,
    {},
    { ...snapshot, projectId: '99999' },
    { ...snapshot, assigneeAccountId: 12 },
    { ...snapshot, issueId: '９９' },
    { ...snapshot, statusId: 'Evidence Review' },
    { ...snapshot, issueTypeId: null },
  ])('fails closed on malformed snapshots %#', (bad) => {
    expect(new OfflineOwnershipPolicy(fence, []).plan(event, bad)).toEqual({
      kind: 'no-op',
      reason: 'invalid-input',
    });
  });

  it('validates baseline/fence with fixed redacted errors', () => {
    for (const baseline of [
      null,
      [{}],
      [{ ...snapshot, updatedAt: later }],
      [
        { ...snapshot, updatedAt: fence },
        { ...snapshot, updatedAt: fence },
      ],
    ]) {
      expect(() => new OfflineOwnershipPolicy(fence, baseline)).toThrow(
        'ownership-baseline-invalid',
      );
    }
    expect(() => new OfflineOwnershipPolicy('secret-invalid-date', [])).toThrow(
      'ownership-baseline-invalid',
    );
  });

  it('requires a fresh matching snapshot, rejects Approved and every changed guard field', () => {
    const plan = new OfflineOwnershipPolicy(fence, []).plan(event, snapshot);
    if (plan.kind !== 'assign') throw new Error('fixture-plan-missing');
    for (const patch of [
      { statusId: '10010' },
      { statusId: '10005' },
      { updatedAt: fence },
      { assigneeAccountId: policy.humanAccountId },
      { issueId: '990002' },
      { issueTypeId: '10009' },
      { projectId: '99999' },
    ]) {
      expect(assignmentStillCurrent(plan, { ...snapshot, ...patch })).toBe(false);
    }
    expect(assignmentStillCurrent(plan, null)).toBe(false);
  });
});
