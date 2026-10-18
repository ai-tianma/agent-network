import type { DbAdapter } from "./db-adapter";

const EVENT_TYPE = "task.delivery.channel_notification_injected";
const eventKey = (inboxId: string) => `channel_notification_injected:${inboxId}`;

export function channelDeliverySupported(database: DbAdapter): boolean {
  return database.atomicTransactions === true && database.transactionalFeaturesRefusal === null;
}

/** Only call inside the recipient-checked ACK transaction; ids come from its
 * owned inbox row, never an additional caller-supplied task id. No body/detail. */
export function recordChannelDelivery(database: DbAdapter, taskId: string, inboxId: string, actor: string): void {
  database.run(
    `INSERT INTO task_events (task_id,from_status,to_status,event_type,event_key,actor,detail,network_id)
     SELECT task_id,NULL,status,?2,?3,?4,NULL,network_id FROM tasks WHERE task_id=?1
     ON CONFLICT(task_id,event_key) DO NOTHING`,
    [taskId, EVENT_TYPE, eventKey(inboxId), actor],
  );
  if (!database.get("SELECT 1 AS seen FROM task_events WHERE task_id=?1 AND event_type=?2 AND event_key=?3", taskId, EVENT_TYPE, eventKey(inboxId))) {
    throw new Error("channel_delivery_task_missing");
  }
}

/** A retry/reassignment creates a new inbox row. Do not project an older
 * injection as evidence for that new delivery, even within the same second. */
export function channelDeliveryAt(database: DbAdapter, taskId: string, networkId: string | null): string | null {
  const row = database.get<{ created_at: string }>(
    `SELECT e.created_at FROM task_events e
      WHERE e.task_id=?1 AND e.event_type=?2
        AND e.event_key=(SELECT 'channel_notification_injected:' || i.id FROM inbox i
          WHERE i.type='task' AND COALESCE(i.task_id,i.id)=?1
            AND ((?3 IS NULL AND i.network_id IS NULL) OR i.network_id=?3)
          ORDER BY i.created_at DESC,i.rowid DESC LIMIT 1)
        AND ((?3 IS NULL AND e.network_id IS NULL) OR e.network_id=?3)
      LIMIT 1`,
    taskId, EVENT_TYPE, networkId,
  );
  return row?.created_at ?? null;
}

type Stage = { state: "observed" | "unknown"; at: string | null };
const observed = (at: unknown): Stage => typeof at === "string" && at.length > 0
  ? { state: "observed", at } : { state: "unknown", at: null };

/** Five independent observations, not five timestamps inferred from ACK.
 * There is deliberately no CLI-admission writer until a real receipt exists. */
export function channelDeliveryStages(task: {
  status?: string; delivered_at?: unknown; consumed_at?: unknown; completed_at?: unknown;
}, injectedAt: string) {
  return {
    delivered: observed(task.delivered_at),
    channel_notification_injected: observed(injectedAt),
    cli_admitted: { state: "unknown" as const, at: null },
    turn_started: observed(task.consumed_at),
    replied: task.status === "replied"
      ? { state: "observed" as const, at: typeof task.completed_at === "string" ? task.completed_at : null }
      : { state: "unknown" as const, at: null },
  };
}
