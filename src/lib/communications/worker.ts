import "server-only";
import {
  claimCommunicationEvents,
  completeCommunicationEvent,
  failCommunicationEvent,
} from "./outbox";
import { prepareDeliveriesForEvent } from "./automation";
import { drainDeliveries, type DeliveryTickResult } from "./delivery";

export type CommunicationTickSummary = DeliveryTickResult & {
  eventsClaimed: number;
  eventsProcessed: number;
  eventsFailed: number;
  deliveriesCreated: number;
  deliveriesDeduplicated: number;
  skipped: number;
};

export async function runCommunicationTick(
  workerId: string,
  log: (message: string) => void = () => {},
): Promise<CommunicationTickSummary> {
  const summary: CommunicationTickSummary = {
    eventsClaimed: 0,
    eventsProcessed: 0,
    eventsFailed: 0,
    deliveriesCreated: 0,
    deliveriesDeduplicated: 0,
    skipped: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    ambiguous: 0,
    cancelled: 0,
  };

  const events = await claimCommunicationEvents(workerId, 10);
  summary.eventsClaimed = events.length;
  for (const event of events) {
    try {
      const prepared = await prepareDeliveriesForEvent(event);
      await completeCommunicationEvent(event.id, workerId);
      summary.eventsProcessed += 1;
      summary.deliveriesCreated += prepared.created;
      summary.deliveriesDeduplicated += prepared.duplicates;
      summary.skipped += prepared.skipped;
    } catch (error) {
      // Query/provider-independent preparation failures are retried from the
      // durable event. No contact data or rendered body is written to logs.
      await failCommunicationEvent(event, workerId, "event_preparation_failed");
      summary.eventsFailed += 1;
      log(`communication event ${event.id.slice(0, 8)} preparation failed (${error instanceof Error ? error.name : "error"})`);
    }
  }

  const deliveries = await drainDeliveries(workerId, 10);
  Object.assign(summary, deliveries);
  if (summary.eventsClaimed || summary.claimed || summary.ambiguous) {
    log(
      `communications: events ${summary.eventsProcessed}/${summary.eventsClaimed}, `
      + `deliveries ${summary.sent} sent, ${summary.retried} retry, ${summary.failed} failed, `
      + `${summary.ambiguous} ambiguous`,
    );
  }
  return summary;
}
