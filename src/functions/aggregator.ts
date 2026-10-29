/**
 * `aggregatorFn` entrypoint — URL-19 (CDK infrastructure / wiring only).
 *
 * The URL-19 stack wires the SQS click-event queue (and its DLQ) to this
 * function as an event source with a batch size of ≤100 (design §3.6). The
 * consumer *logic* — the eventId dedup gate, the `GROUP BY` bucket upserts, the
 * all-time totals and the orphaned-linkId rule (D-8 / AD-9 / AD-10 / §13-c1) —
 * is owned by URL-14, not by the infrastructure ticket.
 *
 * Until URL-14 lands a real consumer, every batch **fails loudly on purpose**:
 * SQS retries it and then parks the messages in the DLQ, which is exactly the
 * visibility path design §3.6/§8.5 prescribes. Silently acknowledging the batch
 * would drop clicks with no trace, and silently succeeding would under-count
 * links; a failing stub keeps the loss observable and reversible.
 *
 * @see infra/lib/url-shortener-stack.ts for the SQS → aggregatorFn wiring.
 */
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

export const AGGREGATOR_NOT_IMPLEMENTED_MESSAGE =
  'aggregatorFn: no consumer is registered yet — the §3.6 dedup/upsert logic is owned ' +
  'by URL-14 (D-8, §13-c1). URL-19 shipped the SQS → aggregatorFn wiring only; this ' +
  'batch fails on purpose so it retries and then parks in the DLQ instead of being ' +
  'silently dropped. Replace this handler with the real consumer.';

/**
 * SQS batch consumer (design §3.6).
 *
 * @throws always, until URL-14 registers the dedup/upsert consumer.
 */
export async function handler(_event: SQSEvent): Promise<SQSBatchResponse> {
  throw new Error(AGGREGATOR_NOT_IMPLEMENTED_MESSAGE);
}
