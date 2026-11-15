/** Pure local assignment planner. No Jira client, executor, bootstrap or replay API. */
import { z } from 'zod';

// Project data, not reusable squad defaults or approval/provenance configuration.
export const ownershipPolicy = Object.freeze({
  projectId: '10001',
  agentsAccountId: '712020:66c3ccd4-64f2-4056-b92f-9505825f58f6',
  humanAccountId: '70121:29771871-918e-4058-959a-76f07cb45530',
  evidenceReviewId: '10009',
  approvedId: '10010',
  inProgressId: '10005',
  activeStatusIds: Object.freeze(['10004', '10005', '10006', '10007', '10008', '10042']),
  issueTypeIds: Object.freeze(['10006', '10007', '10008', '10009']),
});

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const account = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:-]{0,127}$/);
const time = z.iso.datetime({ precision: 3 });
const snapshotSchema = z
  .object({
    issueId: id,
    projectId: z.literal(ownershipPolicy.projectId),
    issueTypeId: z.enum(['10006', '10007', '10008', '10009']),
    statusId: id,
    updatedAt: time,
    assigneeAccountId: account.nullable(),
    customfield_10043: z.unknown().optional(),
  })
  .strict();
const eventSchema = z
  .object({
    eventId: z.string().regex(/^[A-Za-z0-9:-]{1,128}$/),
    issueId: id,
    projectId: z.literal(ownershipPolicy.projectId),
    issueTypeId: z.enum(['10006', '10007', '10008', '10009']),
    fromStatusId: id,
    toStatusId: id,
    createdAt: time,
    actorAccountId: account,
  })
  .strict();

export type OwnershipSnapshot = z.infer<typeof snapshotSchema>;
export type OwnershipEvent = z.infer<typeof eventSchema>;
export type AssignmentPlan = Readonly<{
  kind: 'assign';
  fields: Readonly<{ assignee: Readonly<{ accountId: string }> }>;
  expected: Readonly<Omit<OwnershipSnapshot, 'customfield_10043'>>;
}>;
export type OwnershipDecision =
  | AssignmentPlan
  | Readonly<{
      kind: 'no-op';
      reason:
        | 'invalid-input'
        | 'protected-approved'
        | 'unknown-status'
        | 'historical-or-stale'
        | 'duplicate-event'
        | 'not-a-transition'
        | 'return-not-by-human'
        | 'already-assigned';
    }>;

function knownStatus(status: string): boolean {
  return (
    status === ownershipPolicy.evidenceReviewId ||
    status === ownershipPolicy.approvedId ||
    ownershipPolicy.activeStatusIds.includes(status)
  );
}

/** Volatile simulation state only: restarting requires a new baseline/fence, never replay. */
export class OfflineOwnershipPolicy {
  private readonly protectedIssues = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private readonly lastObserved = new Map<string, number>();
  private readonly fence: number;

  constructor(activatedAt: unknown, baseline: unknown) {
    const parsedTime = time.safeParse(activatedAt);
    const parsedBaseline = z.array(snapshotSchema).safeParse(baseline);
    if (!parsedTime.success || !parsedBaseline.success)
      throw new Error('ownership-baseline-invalid');
    this.fence = Date.parse(parsedTime.data);
    for (const issue of parsedBaseline.data) {
      if (this.lastObserved.has(issue.issueId) || Date.parse(issue.updatedAt) > this.fence) {
        throw new Error('ownership-baseline-invalid');
      }
      this.lastObserved.set(issue.issueId, Date.parse(issue.updatedAt));
      if (issue.statusId === ownershipPolicy.approvedId) this.protectedIssues.add(issue.issueId);
    }
    // Baseline capture deliberately produces no assignments, even for active issues.
  }

  plan(eventInput: unknown, currentInput: unknown): OwnershipDecision {
    const eventResult = eventSchema.safeParse(eventInput);
    const currentResult = snapshotSchema.safeParse(currentInput);
    if (!eventResult.success || !currentResult.success)
      return { kind: 'no-op', reason: 'invalid-input' };
    const event = eventResult.data;
    const current = currentResult.data;
    if (
      current.statusId === ownershipPolicy.approvedId ||
      event.fromStatusId === ownershipPolicy.approvedId ||
      this.protectedIssues.has(current.issueId)
    ) {
      // Never change an Approved record, including a baseline record later reopened.
      if (current.statusId === ownershipPolicy.approvedId)
        this.protectedIssues.add(current.issueId);
      return { kind: 'no-op', reason: 'protected-approved' };
    }
    if (
      !knownStatus(current.statusId) ||
      !knownStatus(event.fromStatusId) ||
      !knownStatus(event.toStatusId)
    ) {
      return { kind: 'no-op', reason: 'unknown-status' };
    }
    if (
      event.issueId !== current.issueId ||
      event.issueTypeId !== current.issueTypeId ||
      event.toStatusId !== current.statusId ||
      event.createdAt !== current.updatedAt ||
      Date.parse(event.createdAt) <= this.fence ||
      Date.parse(event.createdAt) <= (this.lastObserved.get(current.issueId) ?? this.fence)
    ) {
      return { kind: 'no-op', reason: 'historical-or-stale' };
    }
    if (this.seenEvents.has(event.eventId)) return { kind: 'no-op', reason: 'duplicate-event' };
    this.seenEvents.add(event.eventId);
    this.lastObserved.set(current.issueId, Date.parse(current.updatedAt));
    if (event.fromStatusId === event.toStatusId)
      return { kind: 'no-op', reason: 'not-a-transition' };
    if (
      event.fromStatusId === ownershipPolicy.evidenceReviewId &&
      event.toStatusId === ownershipPolicy.inProgressId &&
      event.actorAccountId !== ownershipPolicy.humanAccountId
    ) {
      return { kind: 'no-op', reason: 'return-not-by-human' };
    }
    const target =
      current.statusId === ownershipPolicy.evidenceReviewId
        ? ownershipPolicy.humanAccountId
        : ownershipPolicy.agentsAccountId;
    if (current.assigneeAccountId === target) return { kind: 'no-op', reason: 'already-assigned' };
    return Object.freeze({
      kind: 'assign',
      fields: Object.freeze({ assignee: Object.freeze({ accountId: target }) }),
      expected: Object.freeze({
        issueId: current.issueId,
        projectId: current.projectId,
        issueTypeId: current.issueTypeId,
        statusId: current.statusId,
        updatedAt: current.updatedAt,
        assigneeAccountId: current.assigneeAccountId,
      }),
    });
  }
}

/** Local contract for a future fresh read. NOT an atomic Jira compare-and-set. */
export function assignmentStillCurrent(plan: AssignmentPlan, freshInput: unknown): boolean {
  const fresh = snapshotSchema.safeParse(freshInput);
  if (!fresh.success || fresh.data.statusId === ownershipPolicy.approvedId) return false;
  return Object.entries(plan.expected).every(
    ([key, value]) => fresh.data[key as keyof OwnershipSnapshot] === value,
  );
}
