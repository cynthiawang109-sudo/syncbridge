import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { Envelope } from "./crypto";

const endpoint = process.env.DYNAMODB_URL ?? "http://localhost:4800";
const dynamo = new DynamoDBClient({
  endpoint,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  maxAttempts: 2,
});
const client = DynamoDBDocumentClient.from(dynamo);
const TableName = "webhook_events";
export const ARCHIVE_LEASE_MS = 30000;
export const RETENTION_MS = 30 * 86400000;
const envelope = new Envelope();
type Status = "pending" | "leased" | "processed" | "dead_lettered";
export type ArchiveItem = {
  connection_id: string;
  event_id: string;
  tenant_id: string;
  generation: number;
  encrypted_body: string;
  key_version: string;
  received_at: number;
  status: Status;
  lease_generation: number;
  lease_token?: string;
  lease_expires_at?: number;
  attempt_count: number;
  next_attempt_at: number;
  due_at: number;
  ttl?: number;
  dlq_id?: string;
  replay_id?: string;
};
const conditional = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";
const key = (connection_id: string, event_id: string) => ({
  connection_id,
  event_id,
});
export async function initArchive() {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
      throw error;
    try {
      await dynamo.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "connection_id", AttributeType: "S" },
            { AttributeName: "event_id", AttributeType: "S" },
            { AttributeName: "status", AttributeType: "S" },
            { AttributeName: "next_attempt_at", AttributeType: "N" },
            { AttributeName: "due_at", AttributeType: "N" },
          ],
          KeySchema: [
            { AttributeName: "connection_id", KeyType: "HASH" },
            { AttributeName: "event_id", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: ["next_attempt_at", "due_at"].map(
            (AttributeName) => ({
              IndexName: "status-" + AttributeName,
              KeySchema: [
                { AttributeName: "status", KeyType: "HASH" },
                { AttributeName, KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            }),
          ),
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ResourceInUseException")
        throw error;
    }
  }
  const ttl = await dynamo.send(new DescribeTimeToLiveCommand({ TableName }));
  if (ttl.TimeToLiveDescription?.TimeToLiveStatus === "DISABLED") {
    await dynamo.send(
      new UpdateTimeToLiveCommand({
        TableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
      }),
    );
  }
}
export async function archiveReceipt(
  connection: { id: string; tenantId: string; generation: number },
  eventId: string,
  raw: Buffer,
) {
  const now = Date.now();
  const encrypted = envelope.encryptBytes(raw, connection.id + ":" + eventId);
  const item: ArchiveItem = {
    ...key(connection.id, eventId),
    tenant_id: connection.tenantId,
    generation: connection.generation,
    encrypted_body: encrypted.encryptedTokens,
    key_version: encrypted.keyVersion,
    received_at: now,
    status: "pending",
    lease_generation: 0,
    attempt_count: 0,
    next_attempt_at: now,
    due_at: now,
  };
  try {
    await client.send(
      new PutCommand({
        TableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(connection_id)",
      }),
    );
  } catch (error) {
    if (!conditional(error)) throw error;
  }
}
export function openReceipt(item: ArchiveItem) {
  return envelope.decryptBytes(
    item.encrypted_body,
    item.key_version,
    item.connection_id + ":" + item.event_id,
  );
}
export async function archiveItem(connectionId: string, eventId: string) {
  return (
    await client.send(
      new GetCommand({
        TableName,
        Key: key(connectionId, eventId),
        ConsistentRead: true,
      }),
    )
  ).Item as ArchiveItem | undefined;
}
export async function dueEvents(
  status: "pending" | "leased",
  now = Date.now(),
  cursor?: Record<string, unknown>,
) {
  const result = await client.send(
    new QueryCommand({
      TableName,
      IndexName: "status-due_at",
      Limit: 25,
      ExclusiveStartKey: cursor,
      KeyConditionExpression: "#s = :s AND due_at <= :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":now": now },
    }),
  );
  return {
    items: (result.Items ?? []) as ArchiveItem[],
    cursor: result.LastEvaluatedKey,
  };
}
export async function claimArchive(item: ArchiveItem, now = Date.now()) {
  const lease = now + ARCHIVE_LEASE_MS;
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName,
        Key: key(item.connection_id, item.event_id),
        ConditionExpression:
          "#s = :old AND lease_generation = :gen AND due_at <= :now AND next_attempt_at = :next AND next_attempt_at <= :now AND generation = :connection AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)",
        UpdateExpression:
          "SET #s = :new, lease_generation = lease_generation + :one, lease_token = :token, lease_expires_at = :lease, due_at = :due",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":old": item.status,
          ":new": "leased",
          ":gen": item.lease_generation,
          ":now": now,
          ":connection": item.generation,
          ":one": 1,
          ":token": randomUUID(),
          ":lease": lease,
          ":due": Math.max(lease, item.next_attempt_at),
          ":next": item.next_attempt_at,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as ArchiveItem;
  } catch (error) {
    if (!conditional(error)) throw error;
  }
}
export async function projectArchive(
  item: ArchiveItem,
  update: {
    status: Status;
    due: number;
    attempt: number;
    dlq?: string;
    replay?: string;
  },
) {
  const values: Record<string, string | number> = {
    ":old": item.status,
    ":gen": item.lease_generation,
    ":connection": item.generation,
    ":status": update.status,
    ":due": update.due,
    ":attempt": update.attempt,
  };
  let set =
    "#s = :status, due_at = :due, next_attempt_at = :due, attempt_count = :attempt";
  let remove = "lease_expires_at, lease_token";
  if (update.status === "processed" || update.status === "dead_lettered") {
    values[":expiry"] = Math.floor((Date.now() + RETENTION_MS) / 1000);
    set += ", #ttl = :expiry";
  } else remove += ", #ttl";
  if (update.dlq) {
    set += ", dlq_id = :dlq";
    values[":dlq"] = update.dlq;
  }
  if (update.replay) {
    set += ", replay_id = :replay";
    values[":replay"] = update.replay;
  }
  try {
    await client.send(
      new UpdateCommand({
        TableName,
        Key: key(item.connection_id, item.event_id),
        ConditionExpression:
          "#s = :old AND lease_generation = :gen AND generation = :connection",
        UpdateExpression: "SET " + set + " REMOVE " + remove,
        ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (error) {
    if (!conditional(error)) throw error;
    return false;
  }
}
export async function archiveAudit(
  cursor?: Record<string, unknown>,
  now = Date.now(),
) {
  const result = await client.send(
    new ScanCommand({
      TableName,
      Limit: 100,
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
      FilterExpression:
        "(#s IN (:pending,:leased) AND received_at <= :aged) OR (#s IN (:processed,:dead) AND #ttl <= :now)",
      ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":pending": "pending",
        ":leased": "leased",
        ":processed": "processed",
        ":dead": "dead_lettered",
        ":aged": now - 86400000,
        ":now": Math.floor(now / 1000),
      },
    }),
  );
  return {
    items: (result.Items ?? []) as ArchiveItem[],
    cursor: result.LastEvaluatedKey,
  };
}
export async function expireArchiveItem(item: ArchiveItem, now = Date.now()) {
  try {
    await client.send(
      new DeleteCommand({
        TableName,
        Key: key(item.connection_id, item.event_id),
        ConditionExpression: "#s IN (:processed,:dead) AND #ttl <= :now",
        ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":processed": "processed",
          ":dead": "dead_lettered",
          ":now": Math.floor(now / 1000),
        },
      }),
    );
  } catch (error) {
    if (!conditional(error)) throw error;
  }
}
export async function eraseConnectionArchive(
  connectionId: string,
  tenantId: string,
) {
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName,
        ConsistentRead: true,
        Limit: 50,
        ExclusiveStartKey: cursor,
        KeyConditionExpression: "connection_id = :id",
        ExpressionAttributeValues: { ":id": connectionId },
      }),
    );
    for (const item of result.Items ?? []) {
      if (item.tenant_id !== tenantId)
        throw new Error("Archive tenant mismatch");
      await client.send(
        new DeleteCommand({ TableName, Key: key(connectionId, item.event_id) }),
      );
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
}
export async function hasConnectionArchive(connectionId: string) {
  return !!(
    await client.send(
      new QueryCommand({
        TableName,
        ConsistentRead: true,
        Limit: 1,
        Select: "COUNT",
        KeyConditionExpression: "connection_id = :id",
        ExpressionAttributeValues: { ":id": connectionId },
      }),
    )
  ).Count;
}
