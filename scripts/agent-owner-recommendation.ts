/** Pure local recommendations only. No discovery, executor, clock or persistence. */
import { createHash } from 'node:crypto';

const roles = ['michael', 'jim', 'dwight', 'pam', 'developer', 'human'] as const;
type Role = (typeof roles)[number] | 'ryan';
export interface OwnerRecommendationConfig {
  projectKey: 'URL';
  fieldId: 'customfield_10043';
  humanAccountId: string;
  implementationRole: 'ryan';
  implementationOption: 'developer';
  options: Record<(typeof roles)[number], string>;
  statuses: { approved: string; evidenceReview: string; active: string[] };
}
export interface OwnerSnapshot {
  issueId: string;
  projectKey: 'URL';
  statusId: string;
  revision: number;
  updatedAt: string;
  assigneeAccountId: string | null;
  agentOwnerOptionId: string | null;
  protectedHistory: boolean;
}
export interface OwnerObservation {
  eventId: string;
  issueId: string;
  fromStatusId: string;
  toStatusId: string;
  revision: number;
  at: string;
}
export interface OwnerLocalState {
  version: 1;
  config: string;
  fence: string;
  seen: string[];
  protected: string[];
  observed: { issue: string; revision: number; at: string }[];
}
export interface OwnerRecommendation {
  kind: 'recommendation';
  fields: { customfield_10043: { id: string } };
  expected: {
    config: string;
    snapshot: string;
    state: string;
    evidence: string | null;
    role: Role;
  };
}
type Reason =
  | 'invalid-input'
  | 'config-changed'
  | 'protected-history'
  | 'unknown-status'
  | 'historical-or-stale'
  | 'duplicate-event'
  | 'assignee-drift'
  | 'evidence-required'
  | 'already-correct'
  | 'local-capacity';
export type OwnerRecommendationResult =
  | { kind: 'baseline'; state: OwnerLocalState }
  | { kind: 'hold'; reason: Reason; state?: OwnerLocalState }
  | { kind: 'recommendation'; proposal: OwnerRecommendation; state: OwnerLocalState };

const numericId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const accountId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:-]{0,127}$/.test(value);
const digestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('owner-recommendation-invalid');
}

/** Accept bounded plain data, never invoke accessors/toJSON or serialize raw errors. */
function data(input: unknown): unknown {
  let nodes = 0;
  function copy(value: unknown, depth: number): unknown {
    requireValue(++nodes <= 50000 && depth <= 20);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      requireValue(value.length <= 512);
      return value;
    }
    if (typeof value === 'number') {
      requireValue(Number.isFinite(value));
      return value;
    }
    requireValue(typeof value === 'object' && value !== null);
    requireValue(
      Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null,
    );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireValue(Object.getOwnPropertySymbols(value).length === 0);
    for (const descriptor of Object.values(descriptors)) requireValue('value' in descriptor);
    if (Array.isArray(value)) {
      requireValue(value.length <= 10000 && Object.keys(descriptors).length === value.length + 1);
      return Array.from({ length: value.length }, (_, index) =>
        copy(descriptors[String(index)]!.value, depth + 1),
      );
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(descriptors).sort())
      output[key] = copy(descriptors[key]!.value, depth + 1);
    return output;
  }
  return copy(input, 0);
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  requireValue(Object.keys(value).sort().join(',') === [...keys].sort().join(','));
  return value;
}
function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data(value)))
    .digest('hex');
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function config(input: unknown): OwnerRecommendationConfig {
  const value = object(data(input), [
    'projectKey',
    'fieldId',
    'humanAccountId',
    'implementationRole',
    'implementationOption',
    'options',
    'statuses',
  ]);
  requireValue(
    value.projectKey === 'URL' &&
      value.fieldId === 'customfield_10043' &&
      accountId(value.humanAccountId),
  );
  requireValue(value.implementationRole === 'ryan' && value.implementationOption === 'developer');
  const options = object(value.options, [...roles]);
  requireValue(
    Object.values(options).every(numericId) &&
      new Set(Object.values(options)).size === roles.length,
  );
  const statuses = object(value.statuses, ['approved', 'evidenceReview', 'active']);
  requireValue(
    numericId(statuses.approved) &&
      numericId(statuses.evidenceReview) &&
      Array.isArray(statuses.active) &&
      statuses.active.length > 0 &&
      statuses.active.every(numericId),
  );
  requireValue(
    new Set([statuses.approved, statuses.evidenceReview, ...statuses.active]).size ===
      statuses.active.length + 2,
  );
  return value as unknown as OwnerRecommendationConfig;
}
function snapshot(input: unknown): OwnerSnapshot {
  const value = object(data(input), [
    'issueId',
    'projectKey',
    'statusId',
    'revision',
    'updatedAt',
    'assigneeAccountId',
    'agentOwnerOptionId',
    'protectedHistory',
  ]);
  requireValue(
    numericId(value.issueId) &&
      value.projectKey === 'URL' &&
      numericId(value.statusId) &&
      revision(value.revision) &&
      time(value.updatedAt),
  );
  requireValue(
    (value.assigneeAccountId === null || accountId(value.assigneeAccountId)) &&
      (value.agentOwnerOptionId === null || numericId(value.agentOwnerOptionId)) &&
      typeof value.protectedHistory === 'boolean',
  );
  return value as unknown as OwnerSnapshot;
}
function localState(input: unknown): OwnerLocalState {
  const value = object(data(input), [
    'version',
    'config',
    'fence',
    'seen',
    'protected',
    'observed',
  ]);
  requireValue(value.version === 1 && digestId(value.config) && time(value.fence));
  for (const key of ['seen', 'protected']) {
    const list = value[key];
    requireValue(Array.isArray(list) && list.every(digestId) && new Set(list).size === list.length);
  }
  requireValue(Array.isArray(value.observed));
  for (const entry of value.observed) {
    const row = object(entry, ['issue', 'revision', 'at']);
    requireValue(digestId(row.issue) && revision(row.revision) && time(row.at));
  }
  requireValue(
    new Set(value.observed.map((entry) => (entry as { issue: string }).issue)).size ===
      value.observed.length,
  );
  return value as unknown as OwnerLocalState;
}
function observation(input: unknown): OwnerObservation {
  const value = object(data(input), [
    'eventId',
    'issueId',
    'fromStatusId',
    'toStatusId',
    'revision',
    'at',
  ]);
  requireValue(
    typeof value.eventId === 'string' &&
      /^[A-Za-z0-9:-]{1,128}$/.test(value.eventId) &&
      numericId(value.issueId) &&
      numericId(value.fromStatusId) &&
      numericId(value.toStatusId) &&
      revision(value.revision) &&
      time(value.at),
  );
  return value as unknown as OwnerObservation;
}
const known = (cfg: OwnerRecommendationConfig, status: string) =>
  status === cfg.statuses.approved ||
  status === cfg.statuses.evidenceReview ||
  cfg.statuses.active.includes(status);
function roleOption(cfg: OwnerRecommendationConfig, role: unknown): string {
  requireValue(role === 'ryan' || roles.includes(role as (typeof roles)[number]));
  return cfg.options[
    role === cfg.implementationRole ? cfg.implementationOption : (role as (typeof roles)[number])
  ];
}
/** Fixture correlation only; this cannot authenticate Pam or certify real QA. */
function evidence(input: unknown, current: OwnerSnapshot): string {
  const value = object(data(input), ['role', 'outcome', 'eligible', 'snapshot']);
  requireValue(value.role === 'pam' && value.outcome === 'PASS' && value.eligible === true);
  requireValue(fingerprint(snapshot(value.snapshot)) === fingerprint(current));
  return fingerprint(value);
}
function hold(reason: Reason, state?: OwnerLocalState): OwnerRecommendationResult {
  return frozen(
    state ? { kind: 'hold' as const, reason, state } : { kind: 'hold' as const, reason },
  );
}

/** Baseline capture returns state only: no recommendations, including active issues. */
export function baselineOwnerRecommendations(
  configInput: unknown,
  fenceInput: unknown,
  baselineInput: unknown,
): OwnerRecommendationResult {
  try {
    const cfg = config(configInput);
    requireValue(time(fenceInput));
    const baseline = data(baselineInput);
    requireValue(Array.isArray(baseline));
    const rows = baseline.map(snapshot);
    requireValue(
      new Set(rows.map((row) => row.issueId)).size === rows.length &&
        rows.every((row) => row.updatedAt <= fenceInput),
    );
    return frozen({
      kind: 'baseline',
      state: {
        version: 1,
        config: fingerprint(cfg),
        fence: fenceInput,
        seen: [],
        protected: rows
          .filter((row) => row.statusId === cfg.statuses.approved || row.protectedHistory)
          .map((row) => fingerprint(row.issueId))
          .sort(),
        observed: rows
          .map((row) => ({
            issue: fingerprint(row.issueId),
            revision: row.revision,
            at: row.updatedAt,
          }))
          .sort((a, b) => (a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0)),
      },
    });
  } catch {
    return hold('invalid-input');
  }
}

/** Explicit in/out local state, never applied to Jira or persisted implicitly. */
export function recommendAgentOwner(
  configInput: unknown,
  stateInput: unknown,
  eventInput: unknown,
  currentInput: unknown,
  role: unknown,
  evidenceInput?: unknown,
): OwnerRecommendationResult {
  try {
    const cfg = config(configInput),
      state = localState(stateInput);
    const option = roleOption(cfg, role);
    if (state.config !== fingerprint(cfg)) return hold('config-changed', state);
    const event = observation(eventInput),
      current = snapshot(currentInput);
    const issue = fingerprint(current.issueId);
    const protectedIssue =
      current.protectedHistory ||
      current.statusId === cfg.statuses.approved ||
      (event.issueId === current.issueId &&
        (event.fromStatusId === cfg.statuses.approved ||
          event.toStatusId === cfg.statuses.approved)) ||
      state.protected.includes(issue);
    if (protectedIssue) {
      if (!state.protected.includes(issue) && state.protected.length >= 10000)
        return hold('local-capacity');
      if (!state.protected.includes(issue)) state.protected.push(issue);
      return hold('protected-history', state);
    }
    if (
      ![current.statusId, event.fromStatusId, event.toStatusId].every((status) =>
        known(cfg, status),
      )
    )
      return hold('unknown-status', state);
    const eventId = fingerprint(event.eventId);
    if (state.seen.includes(eventId)) return hold('duplicate-event', state);
    const last = state.observed.find((row) => row.issue === issue);
    if (
      event.issueId !== current.issueId ||
      event.toStatusId !== current.statusId ||
      event.revision !== current.revision ||
      event.at !== current.updatedAt ||
      event.at <= state.fence ||
      (last && (event.revision <= last.revision || event.at <= last.at))
    )
      return hold('historical-or-stale', state);
    if (state.seen.length >= 10000 || (!last && state.observed.length >= 10000))
      return hold('local-capacity', state);
    state.seen.push(eventId);
    state.observed = [
      ...state.observed.filter((row) => row.issue !== issue),
      { issue, revision: event.revision, at: event.at },
    ].sort((a, b) => (a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0));
    if (current.assigneeAccountId !== cfg.humanAccountId) return hold('assignee-drift', state);
    let evidenceFingerprint: string | null = null;
    if (current.statusId === cfg.statuses.evidenceReview) {
      if (role !== 'human') return hold('evidence-required', state);
      try {
        evidenceFingerprint = evidence(evidenceInput, current);
      } catch {
        return hold('evidence-required', state);
      }
    } else if (evidenceInput !== undefined) return hold('evidence-required', state);
    if (current.agentOwnerOptionId === option) return hold('already-correct', state);
    return frozen({
      kind: 'recommendation',
      state,
      proposal: {
        kind: 'recommendation',
        fields: { customfield_10043: { id: option } },
        expected: {
          config: fingerprint(cfg),
          snapshot: fingerprint(current),
          state: fingerprint(state),
          evidence: evidenceFingerprint,
          role: role as Role,
        },
      },
    });
  } catch {
    return hold('invalid-input');
  }
}

/** Local freshness comparison, NOT atomicity, execution authority or actor identity. */
export function ownerRecommendationStillCurrent(
  proposalInput: unknown,
  configInput: unknown,
  stateInput: unknown,
  currentInput: unknown,
  evidenceInput?: unknown,
): boolean {
  try {
    const cfg = config(configInput),
      state = localState(stateInput),
      current = snapshot(currentInput);
    const proposal = object(data(proposalInput), ['kind', 'fields', 'expected']);
    const fields = object(proposal.fields, ['customfield_10043']);
    const option = object(fields.customfield_10043, ['id']);
    const expected = object(proposal.expected, ['config', 'snapshot', 'state', 'evidence', 'role']);
    if (
      proposal.kind !== 'recommendation' ||
      option.id !== roleOption(cfg, expected.role) ||
      current.assigneeAccountId !== cfg.humanAccountId ||
      current.protectedHistory ||
      current.statusId === cfg.statuses.approved ||
      !known(cfg, current.statusId) ||
      state.protected.includes(fingerprint(current.issueId))
    )
      return false;
    if (
      expected.config !== fingerprint(cfg) ||
      state.config !== expected.config ||
      expected.snapshot !== fingerprint(current) ||
      expected.state !== fingerprint(state)
    )
      return false;
    if (current.statusId === cfg.statuses.evidenceReview)
      return expected.role === 'human' && expected.evidence === evidence(evidenceInput, current);
    return expected.evidence === null && evidenceInput === undefined;
  } catch {
    return false;
  }
}
