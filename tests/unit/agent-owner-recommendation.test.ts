import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baselineOwnerRecommendations,
  recommendAgentOwner,
  ownerRecommendationStillCurrent,
} from '../../scripts/agent-owner-recommendation.ts';
import { ownerFixture, ownerPlan, fence, later } from '../helpers/owner-recommendation-fixture.ts';

describe('pure Agent Owner recommendations (not historical Assignee handoff)', () => {
  it('consumes protected holds before cross-issue/altered-payload replay, carrying every returned hold state', () => {
    const f = ownerFixture();
    const approved = { ...f.current, statusId: f.config.statuses.approved };
    const baseline = baselineOwnerRecommendations(f.config, fence, [
      { ...approved, updatedAt: fence, revision: 0 },
    ]);
    if (baseline.kind !== 'baseline') throw new Error('fixture-baseline-missing');
    const cases = [
      { state: f.state, event: { ...f.event, toStatusId: approved.statusId }, current: approved },
      {
        state: f.state,
        event: { ...f.event, fromStatusId: approved.statusId },
        current: f.current,
      },
      { state: f.state, event: f.event, current: { ...f.current, protectedHistory: true } },
      { state: baseline.state, event: f.event, current: f.current },
      {
        state: f.state,
        event: { ...f.event, at: fence, revision: 0 },
        current: { ...approved, updatedAt: fence, revision: 0 },
      },
    ];
    for (const item of cases) {
      const before = JSON.stringify(item);
      const held = recommendAgentOwner(f.config, item.state, item.event, item.current, 'ryan');
      expect(held).toMatchObject({ kind: 'hold', reason: 'protected-history' });
      if (held.kind !== 'hold' || !held.state) throw new Error('fixture-state-missing');
      expect(held.state.seen).toHaveLength(1);
      expect(held.state.protected).toHaveLength(1);
      let state = held.state;
      for (const patch of [
        { issueId: '990002' },
        {
          issueId: '990003',
          revision: 2,
          updatedAt: '2026-01-01T00:02:00.000Z',
          statusId: '10006',
        },
      ]) {
        const other = { ...f.current, ...patch };
        const event = {
          ...f.event,
          issueId: other.issueId,
          toStatusId: other.statusId,
          revision: other.revision,
          at: other.updatedAt,
        };
        const replay = recommendAgentOwner(f.config, state, event, other, 'human');
        expect(replay).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
        expect(
          ownerRecommendationStillCurrent(
            replay.kind === 'recommendation' ? replay.proposal : undefined,
            f.config,
            'state' in replay ? replay.state : undefined,
            other,
          ),
        ).toBe(false);
        if (replay.kind !== 'hold' || !replay.state) throw new Error('fixture-state-missing');
        state = replay.state;
      }
      const repeated = recommendAgentOwner(f.config, state, item.event, item.current, 'ryan');
      expect(repeated).toMatchObject({ kind: 'hold', reason: 'protected-history', state });
      expect(JSON.stringify(item)).toBe(before);
    }
  });

  it('retains each reopened protected observation identity without growing on repeats', () => {
    const f = ownerFixture();
    const first = recommendAgentOwner(
      f.config,
      f.state,
      f.event,
      { ...f.current, protectedHistory: true },
      'ryan',
    );
    if (first.kind !== 'hold' || !first.state) throw new Error('fixture-state-missing');
    const current = { ...f.current, revision: 2, updatedAt: '2026-01-01T00:02:00.000Z' };
    const event = { ...f.event, eventId: 'reopened-event', revision: 2, at: current.updatedAt };
    const reopened = recommendAgentOwner(f.config, first.state, event, current, 'dwight');
    if (reopened.kind !== 'hold' || !reopened.state) throw new Error('fixture-state-missing');
    expect(reopened.reason).toBe('protected-history');
    expect(reopened.state.seen).toHaveLength(2);
    expect(reopened.state.protected).toEqual(first.state.protected);
    const repeated = recommendAgentOwner(f.config, reopened.state, event, current, 'dwight');
    expect(repeated).toEqual(reopened);
    if (repeated.kind !== 'hold' || !repeated.state) throw new Error('fixture-state-missing');
    expect(
      recommendAgentOwner(
        f.config,
        repeated.state,
        { ...event, issueId: '990002' },
        { ...current, issueId: '990002' },
        'ryan',
      ),
    ).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
  });

  it('halts at full protected/seen capacity without eviction, reset or an unsafe continuation state', () => {
    const f = ownerFixture();
    const ids = Array.from({ length: 10000 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'),
    );
    for (const patch of [{ seen: ids }, { protected: ids }, { seen: ids, protected: ids }]) {
      const state = { ...f.state, ...patch };
      const before = JSON.stringify(state);
      const result = recommendAgentOwner(
        f.config,
        state,
        f.event,
        { ...f.current, protectedHistory: true },
        'ryan',
      );
      expect(result).toEqual({ kind: 'hold', reason: 'local-capacity' });
      expect(result).not.toHaveProperty('state');
      expect(result).not.toHaveProperty('proposal');
      expect(JSON.stringify(state)).toBe(before);
      expect(ownerRecommendationStillCurrent(undefined, f.config, undefined, f.current)).toBe(
        false,
      );
    }
    const near = { ...f.state, seen: ids.slice(0, 9999), protected: ids.slice(0, 9999) };
    const held = recommendAgentOwner(
      f.config,
      near,
      f.event,
      { ...f.current, protectedHistory: true },
      'ryan',
    );
    if (held.kind !== 'hold' || !held.state) throw new Error('fixture-state-missing');
    expect(held.reason).toBe('protected-history');
    expect(held.state.seen).toHaveLength(10000);
    expect(held.state.protected).toHaveLength(10000);
    expect(held.state.seen.slice(0, 9999)).toEqual(near.seen);
    expect(held.state.protected.slice(0, 9999)).toEqual(near.protected);
    const repeated = recommendAgentOwner(f.config, held.state, f.event, f.current, 'ryan');
    expect(repeated).toEqual(held);
    if (repeated.kind !== 'hold' || !repeated.state) throw new Error('fixture-state-missing');
    const replay = recommendAgentOwner(
      f.config,
      repeated.state,
      { ...f.event, issueId: '990002' },
      { ...f.current, issueId: '990002' },
      'ryan',
    );
    expect(replay).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
    expect(
      ownerRecommendationStillCurrent(
        replay.kind === 'recommendation' ? replay.proposal : undefined,
        f.config,
        'state' in replay ? replay.state : undefined,
        { ...f.current, issueId: '990002' },
      ),
    ).toBe(false);
    const fullSeen = { ...f.state, seen: held.state.seen, protected: ids.slice(0, 9999) };
    const sameEvent = recommendAgentOwner(
      f.config,
      fullSeen,
      f.event,
      { ...f.current, protectedHistory: true },
      'ryan',
    );
    if (sameEvent.kind !== 'hold' || !sameEvent.state) throw new Error('fixture-state-missing');
    expect(sameEvent.reason).toBe('protected-history');
    expect(sameEvent.state.seen).toEqual(fullSeen.seen);
    expect(sameEvent.state.protected).toHaveLength(10000);
    const fullProtected = { ...f.state, protected: held.state.protected };
    const newEvent = recommendAgentOwner(
      f.config,
      fullProtected,
      { ...f.event, eventId: 'another-protected-event' },
      f.current,
      'ryan',
    );
    if (newEvent.kind !== 'hold' || !newEvent.state) throw new Error('fixture-state-missing');
    expect(newEvent.reason).toBe('protected-history');
    expect(newEvent.state.protected).toEqual(fullProtected.protected);
    expect(newEvent.state.seen).toHaveLength(1);
    expect(
      recommendAgentOwner(
        f.config,
        newEvent.state,
        { ...f.event, eventId: 'another-protected-event', issueId: '990002' },
        { ...f.current, issueId: '990002' },
        'ryan',
      ),
    ).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
  });

  it('preserves malformed-input validation ahead of protected event consumption', () => {
    const f = ownerFixture();
    const protectedCurrent = { ...f.current, protectedHistory: true };
    for (const event of [
      { ...f.event, eventId: 'PRIVATE\nvalue' },
      { ...f.event, at: 'PRIVATE' },
    ]) {
      const before = JSON.stringify(f.state);
      expect(recommendAgentOwner(f.config, f.state, event, protectedCurrent, 'ryan')).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
      expect(JSON.stringify(f.state)).toBe(before);
    }
  });
  it('matches the explicit normalized source configuration, without runtime discovery', () => {
    const source = JSON.parse(
      readFileSync(
        new URL('../../specs/url-shortener-api/squad.config.json', import.meta.url),
        'utf8',
      ),
    );
    const f = ownerFixture();
    expect(f.config.humanAccountId).toBe(source.jira.defaultAssignee.accountId);
    expect(f.config.fieldId).toBe(source.jira.agentOwner.fieldId);
    expect(f.config.options).toEqual(source.jira.agentOwner.options);
    expect(f.config.implementationRole).toBe(
      source.operatingPolicy.roleMapping.implementationAgent,
    );
    expect(f.config.implementationOption).toBe(
      source.operatingPolicy.roleMapping.implementationAgentOwnerOption,
    );
  });

  it.each([
    ['michael', '10020'],
    ['jim', '10021'],
    ['dwight', '10022'],
    ['pam', '10023'],
    ['developer', '10024'],
    ['ryan', '10024'],
    ['human', '10025'],
  ])('maps explicit %s to the exact configured option %s and nothing else', (role, option) => {
    const f = ownerFixture();
    const result = recommendAgentOwner(f.config, f.state, f.event, f.current, role);
    expect(result.kind).toBe('recommendation');
    if (result.kind !== 'recommendation') throw new Error('fixture-recommendation-missing');
    expect(result.proposal.fields).toEqual({ customfield_10043: { id: option } });
    expect(Object.keys(result.proposal.fields)).toEqual(['customfield_10043']);
    expect(Object.keys(result.proposal.fields.customfield_10043)).toEqual(['id']);
    expect(Object.isFrozen(result.proposal.fields.customfield_10043)).toBe(true);
    expect(
      ownerRecommendationStillCurrent(result.proposal, f.config, result.state, f.current),
    ).toBe(true);
    expect(f.current.assigneeAccountId).toBe(f.config.humanAccountId);
  });

  it('uses supplied mappings, not hardcoded option IDs, with explicit config invalidation', () => {
    const f = ownerFixture();
    f.config.options.developer = '990024';
    const baseline = baselineOwnerRecommendations(f.config, fence, []);
    if (baseline.kind !== 'baseline') throw new Error('fixture-baseline-missing');
    const result = recommendAgentOwner(f.config, baseline.state, f.event, f.current, 'ryan');
    if (result.kind !== 'recommendation') throw new Error('fixture-recommendation-missing');
    expect(result.proposal.fields.customfield_10043.id).toBe('990024');
    expect(recommendAgentOwner(f.config, f.state, f.event, f.current, 'ryan')).toMatchObject({
      kind: 'hold',
      reason: 'config-changed',
    });
  });

  it.each([null, '712020:66c3ccd4-64f2-4056-b92f-9505825f58f6', 'fixture-other-account'])(
    'holds assignee drift %s without proposing repair',
    (assigneeAccountId) => {
      const f = ownerFixture();
      const result = recommendAgentOwner(
        f.config,
        f.state,
        f.event,
        { ...f.current, assigneeAccountId },
        'ryan',
      );
      expect(result).toMatchObject({ kind: 'hold', reason: 'assignee-drift' });
      expect(result).not.toHaveProperty('proposal');
      expect(result).not.toHaveProperty('fields');
      expect(JSON.stringify(result)).not.toContain('accountId');
    },
  );

  it('emits no proposal for already-correct owner and consumes the local observation', () => {
    const f = ownerFixture();
    const current = { ...f.current, agentOwnerOptionId: '10024' };
    const result = recommendAgentOwner(f.config, f.state, f.event, current, 'ryan');
    expect(result).toMatchObject({ kind: 'hold', reason: 'already-correct' });
    if (!('state' in result)) throw new Error('fixture-state-missing');
    expect(recommendAgentOwner(f.config, result.state, f.event, current, 'dwight')).toMatchObject({
      kind: 'hold',
      reason: 'duplicate-event',
    });
  });

  it.each([undefined, null, '', 'Ryan', 'Agents', 'unknown', {}, '__proto__', 'constructor'])(
    'fails closed on unknown requested role %#',
    (role) => {
      const f = ownerFixture();
      expect(recommendAgentOwner(f.config, f.state, f.event, f.current, role)).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    },
  );

  it('rejects missing, malformed, ambiguous or retargeted configuration with fixed redaction', () => {
    const f = ownerFixture();
    for (const config of [
      null,
      {},
      { ...f.config, options: undefined },
      { ...f.config, fieldId: 'assignee' },
      { ...f.config, fieldId: 'customfield_99999' },
      { ...f.config, humanAccountId: null },
      { ...f.config, implementationOption: 'human' },
      { ...f.config, options: { ...f.config.options, developer: 'PRIVATE secret' } },
      { ...f.config, options: { ...f.config.options, human: '10024' } },
      { ...f.config, options: { developer: '10024' } },
      { ...f.config, options: { ...f.config.options, extra: '99999' } },
      { ...f.config, statuses: { ...f.config.statuses, active: ['10010'] } },
      { ...f.config, token: 'PRIVATE' },
    ]) {
      expect(baselineOwnerRecommendations(config, fence, [])).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
      expect(recommendAgentOwner(config, f.state, f.event, f.current, 'ryan')).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    }
  });

  it('captures baseline without actions and retains Approved/protected history after reopen', () => {
    const f = ownerFixture();
    for (const patch of [{ statusId: '10010' }, { protectedHistory: true }]) {
      const baseline = baselineOwnerRecommendations(f.config, fence, [
        { ...f.current, ...patch, updatedAt: fence },
      ]);
      expect(baseline.kind).toBe('baseline');
      expect(baseline).not.toHaveProperty('proposal');
      if (baseline.kind !== 'baseline') throw new Error('fixture-baseline-missing');
      expect(
        recommendAgentOwner(f.config, baseline.state, f.event, f.current, 'ryan'),
      ).toMatchObject({ kind: 'hold', reason: 'protected-history' });
    }
    const activeBaseline = baselineOwnerRecommendations(f.config, later, [f.current]);
    if (activeBaseline.kind !== 'baseline') throw new Error('fixture-baseline-missing');
    expect(
      recommendAgentOwner(f.config, activeBaseline.state, f.event, f.current, 'ryan'),
    ).toMatchObject({ kind: 'hold', reason: 'historical-or-stale' });
    for (const [event, current] of [
      [
        { ...f.event, toStatusId: '10010' },
        { ...f.current, statusId: '10010' },
      ],
      [{ ...f.event, fromStatusId: '10010' }, f.current],
      [{ ...f.event, toStatusId: '10010' }, f.current],
      [f.event, { ...f.current, protectedHistory: true }],
    ] as const) {
      const held = recommendAgentOwner(f.config, f.state, event, current, 'ryan');
      expect(held).toMatchObject({ kind: 'hold', reason: 'protected-history' });
      if (!('state' in held)) throw new Error('fixture-state-missing');
      expect(recommendAgentOwner(f.config, held.state, f.event, f.current, 'ryan')).toMatchObject({
        kind: 'hold',
        reason: 'protected-history',
      });
    }
  });

  it('deduplicates supplied state and rejects stale/out-of-order observations without replay', () => {
    const f = ownerPlan();
    expect(
      recommendAgentOwner(
        f.config,
        f.result.state,
        { ...f.event, issueId: '990002' },
        { ...f.current, issueId: '990002' },
        'dwight',
      ),
    ).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
    expect(recommendAgentOwner(f.config, f.result.state, f.event, f.current, 'ryan')).toMatchObject(
      { kind: 'hold', reason: 'duplicate-event' },
    );
    expect(
      recommendAgentOwner(
        f.config,
        f.result.state,
        { ...f.event, revision: 2, at: '2026-01-01T00:02:00.000Z' },
        { ...f.current, revision: 2, updatedAt: '2026-01-01T00:02:00.000Z' },
        'dwight',
      ),
    ).toMatchObject({ kind: 'hold', reason: 'duplicate-event' });
    for (const patch of [
      { revision: 0 },
      { at: fence },
      { issueId: '990002' },
      { toStatusId: '10006' },
    ]) {
      expect(
        recommendAgentOwner(f.config, f.state, { ...f.event, ...patch }, f.current, 'ryan'),
      ).toMatchObject({ kind: 'hold', reason: 'historical-or-stale' });
    }
    const next = { ...f.event, eventId: 'newer', revision: 2, at: '2026-01-01T00:02:00.000Z' };
    const newer = recommendAgentOwner(
      f.config,
      f.result.state,
      next,
      { ...f.current, revision: 2, updatedAt: next.at },
      'dwight',
    );
    if (!('state' in newer)) throw new Error('fixture-state-missing');
    expect(
      recommendAgentOwner(f.config, newer.state, { ...f.event, eventId: 'old' }, f.current, 'ryan'),
    ).toMatchObject({ kind: 'hold', reason: 'historical-or-stale' });
  });

  it('invalidates every changed issue/status/revision/assignee/owner/history/config/state dimension', () => {
    const f = ownerPlan();
    const fresh = (
      current: unknown = f.current,
      config: unknown = f.config,
      state: unknown = f.result.state,
    ) => ownerRecommendationStillCurrent(f.result.proposal, config, state, current);
    for (const patch of [
      { issueId: '990002' },
      { projectKey: 'OTHER' },
      { statusId: '10006' },
      { statusId: '10010' },
      { revision: 2 },
      { updatedAt: '2026-01-01T00:02:00.000Z' },
      { assigneeAccountId: null },
      { assigneeAccountId: 'other' },
      { agentOwnerOptionId: '10022' },
      { protectedHistory: true },
    ])
      expect(fresh({ ...f.current, ...patch })).toBe(false);
    for (const patch of [
      { humanAccountId: 'other' },
      { options: { ...f.config.options, developer: '990024' } },
      { statuses: { ...f.config.statuses, active: ['10005'] } },
      { fieldId: 'status' },
      { projectKey: 'OTHER' },
    ])
      expect(fresh(f.current, { ...f.config, ...patch })).toBe(false);
    expect(fresh(f.current, f.config, f.state)).toBe(false);
    expect(fresh(null)).toBe(false);
    for (const fields of [
      { assignee: { accountId: 'other' } },
      { ...f.result.proposal.fields, status: '10010' },
      { customfield_10043: { id: '10025' } },
    ])
      expect(
        ownerRecommendationStillCurrent(
          { ...f.result.proposal, fields },
          f.config,
          f.result.state,
          f.current,
        ),
      ).toBe(false);
  });

  it('allows only a Human owner recommendation with matching eligible Pam PASS for Evidence Review', () => {
    const f = ownerFixture();
    const current = { ...f.current, statusId: '10009' };
    const event = { ...f.event, toStatusId: current.statusId };
    const evidence = { role: 'pam', outcome: 'PASS', eligible: true, snapshot: current };
    const good = recommendAgentOwner(f.config, f.state, event, current, 'human', evidence);
    if (good.kind !== 'recommendation') throw new Error('fixture-recommendation-missing');
    expect(good.proposal.fields).toEqual({ customfield_10043: { id: '10025' } });
    expect(
      ownerRecommendationStillCurrent(good.proposal, f.config, good.state, current, evidence),
    ).toBe(true);
    for (const value of [
      undefined,
      null,
      {},
      { ...evidence, role: 'ryan' },
      { ...evidence, outcome: 'FAIL' },
      { ...evidence, outcome: 'BLOCKED' },
      { ...evidence, eligible: false },
      { ...evidence, snapshot: { ...current, revision: 0 } },
      { ...evidence, snapshot: { ...current, assigneeAccountId: null } },
    ]) {
      expect(recommendAgentOwner(f.config, f.state, event, current, 'human', value)).toMatchObject({
        kind: 'hold',
        reason: 'evidence-required',
      });
      expect(
        ownerRecommendationStillCurrent(good.proposal, f.config, good.state, current, value),
      ).toBe(false);
    }
    for (const role of ['ryan', 'pam', 'dwight', 'michael', 'developer'])
      expect(recommendAgentOwner(f.config, f.state, event, current, role, evidence)).toMatchObject({
        kind: 'hold',
        reason: 'evidence-required',
      });
    expect(
      recommendAgentOwner(f.config, f.state, f.event, f.current, 'ryan', evidence),
    ).toMatchObject({ kind: 'hold', reason: 'evidence-required' });
  });

  it('returns deterministic redacted data, does not mutate frozen inputs or invoke accessors', () => {
    const f = ownerFixture();
    const before = JSON.stringify(f);
    const freeze = (value: unknown) => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(f);
    const first = recommendAgentOwner(f.config, f.state, f.event, f.current, 'ryan');
    expect(recommendAgentOwner(f.config, f.state, f.event, f.current, 'ryan')).toEqual(first);
    expect(JSON.stringify(f)).toBe(before);
    for (const privateValue of [f.config.humanAccountId, f.current.issueId, f.event.eventId])
      expect(JSON.stringify(first)).not.toContain(privateValue);
    let reads = 0;
    const bad = {
      ...f.current,
      get token() {
        reads++;
        throw new Error('PRIVATE');
      },
    };
    expect(recommendAgentOwner(f.config, f.state, f.event, bad, 'ryan')).toEqual({
      kind: 'hold',
      reason: 'invalid-input',
    });
    expect(reads).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;
    expect(recommendAgentOwner(cycle, f.state, f.event, f.current, 'ryan')).toEqual({
      kind: 'hold',
      reason: 'invalid-input',
    });
  });

  it('holds unknown statuses and malformed baseline/event/state/snapshot data without private diagnostics', () => {
    const f = ownerFixture();
    for (const baseline of [
      null,
      {},
      [f.current],
      [
        { ...f.current, updatedAt: fence },
        { ...f.current, updatedAt: fence },
      ],
    ])
      expect(baselineOwnerRecommendations(f.config, fence, baseline)).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    expect(baselineOwnerRecommendations(f.config, 'PRIVATE', [])).toEqual({
      kind: 'hold',
      reason: 'invalid-input',
    });
    for (const event of [
      null,
      { ...f.event, eventId: 'PRIVATE\nvalue' },
      { ...f.event, at: '2026-02-30T00:00:00.000Z' },
      { ...f.event, revision: NaN },
      { ...f.event, actorAccountId: 'PRIVATE' },
    ])
      expect(recommendAgentOwner(f.config, f.state, event, f.current, 'ryan')).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    for (const current of [
      null,
      { ...f.current, assigneeAccountId: 12 },
      { ...f.current, agentOwnerOptionId: {} },
      { ...f.current, token: 'PRIVATE' },
    ])
      expect(recommendAgentOwner(f.config, f.state, f.event, current, 'ryan')).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    for (const state of [
      null,
      { ...f.state, version: 2 },
      { ...f.state, seen: ['PRIVATE'] },
      { ...f.state, observed: [{ issue: 'PRIVATE' }] },
      { ...f.state, config: 'PRIVATE' },
    ])
      expect(recommendAgentOwner(f.config, state, f.event, f.current, 'ryan')).toEqual({
        kind: 'hold',
        reason: 'invalid-input',
      });
    expect(
      recommendAgentOwner(
        f.config,
        f.state,
        { ...f.event, fromStatusId: '99999' },
        f.current,
        'ryan',
      ),
    ).toMatchObject({ kind: 'hold', reason: 'unknown-status' });
  });

  it('does not evict state or silently reset a full local fixture ledger', () => {
    const f = ownerFixture();
    const ids = Array.from({ length: 10000 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'),
    );
    const full = { ...f.state, seen: ids };
    const result = recommendAgentOwner(f.config, full, f.event, f.current, 'ryan');
    expect(result).toMatchObject({ kind: 'hold', reason: 'local-capacity', state: full });
    expect(full.seen).toHaveLength(10000);
    expect(
      recommendAgentOwner(
        f.config,
        { ...f.state, protected: ids },
        f.event,
        { ...f.current, protectedHistory: true },
        'ryan',
      ),
    ).toEqual({ kind: 'hold', reason: 'local-capacity' });
  });

  it('is independent of baseline row order and carries independent issue observations explicitly', () => {
    const f = ownerFixture();
    const rows = [
      { ...f.current, updatedAt: fence, revision: 0 },
      { ...f.current, issueId: '990002', updatedAt: fence, revision: 0 },
    ];
    const first = baselineOwnerRecommendations(f.config, fence, rows);
    expect(baselineOwnerRecommendations(f.config, fence, [...rows].reverse())).toEqual(first);
    if (first.kind !== 'baseline') throw new Error('fixture-baseline-missing');
    const plan = recommendAgentOwner(f.config, first.state, f.event, f.current, 'ryan');
    if (plan.kind !== 'recommendation') throw new Error('fixture-recommendation-missing');
    const second = recommendAgentOwner(
      f.config,
      plan.state,
      { ...f.event, issueId: '990002', eventId: 'second-event' },
      { ...f.current, issueId: '990002' },
      'dwight',
    );
    expect(second.kind).toBe('recommendation');
    expect(first.state.observed).toEqual(
      rows.map((row) => expect.objectContaining({ revision: row.revision, at: row.updatedAt })),
    );
  });
});
