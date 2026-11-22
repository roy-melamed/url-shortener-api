import {
  baselineOwnerRecommendations,
  recommendAgentOwner,
  type OwnerRecommendationConfig,
  type OwnerSnapshot,
} from '../../scripts/agent-owner-recommendation.ts';

export const fence = '2026-01-01T00:00:00.000Z';
export const later = '2026-01-01T00:01:00.000Z';
export function ownerFixture() {
  const config: OwnerRecommendationConfig = {
    projectKey: 'URL',
    fieldId: 'customfield_10043',
    humanAccountId: '70121:29771871-918e-4058-959a-76f07cb45530',
    implementationRole: 'ryan',
    implementationOption: 'developer',
    options: {
      michael: '10020',
      jim: '10021',
      dwight: '10022',
      pam: '10023',
      developer: '10024',
      human: '10025',
    },
    statuses: {
      approved: '10010',
      evidenceReview: '10009',
      active: ['10004', '10005', '10006', '10007', '10008', '10042'],
    },
  };
  const current: OwnerSnapshot = {
    issueId: '990001',
    projectKey: 'URL',
    statusId: '10005',
    revision: 1,
    updatedAt: later,
    assigneeAccountId: config.humanAccountId,
    agentOwnerOptionId: null,
    protectedHistory: false,
  };
  const event = {
    eventId: 'fixture-event',
    issueId: current.issueId,
    fromStatusId: '10004',
    toStatusId: current.statusId,
    revision: current.revision,
    at: current.updatedAt,
  };
  const baseline = baselineOwnerRecommendations(config, fence, []);
  if (baseline.kind !== 'baseline') throw new Error('fixture-baseline-missing');
  return { config, current, event, state: baseline.state };
}
export function ownerPlan() {
  const f = ownerFixture();
  const result = recommendAgentOwner(f.config, f.state, f.event, f.current, 'ryan');
  if (result.kind !== 'recommendation') throw new Error('fixture-recommendation-missing');
  return { ...f, result };
}
