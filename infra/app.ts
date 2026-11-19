import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as redis from "aws-cdk-lib/aws-elasticache";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { resolve } from "node:path";

const app = new cdk.App();
const stack = new cdk.Stack(app, "SyncBridgeDemo", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ca-central-1" },
  synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: "syncbdemo" }),
});
cdk.Tags.of(stack).add("project", "syncbridge");
cdk.Tags.of(stack).add("ephemeral", "true");
const destroy = cdk.RemovalPolicy.DESTROY;
const clientCidr = new cdk.CfnParameter(stack, "ClientCidr", {
  description: "Trusted demo operator IPv4 CIDR",
  allowedPattern: "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/32",
});
const certificateArn = new cdk.CfnParameter(stack, "CertificateArn", {
  description: "Temporary certificate trusted by the demo client",
});
const vpc = new ec2.Vpc(stack, "Vpc", {
  availabilityZones: ["ca-central-1a", "ca-central-1b"],
  natGateways: 0,
  subnetConfiguration: [
    { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});
const publicSubnets = { subnetType: ec2.SubnetType.PUBLIC };
const isolatedSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
const cluster = new ecs.Cluster(stack, "Cluster", {
  vpc,
  defaultCloudMapNamespace: { name: "syncbridge.internal" },
});
const tasks = new ec2.SecurityGroup(stack, "Tasks", { vpc });
const databaseGroup = new ec2.SecurityGroup(stack, "DatabaseAccess", { vpc });
const cacheGroup = new ec2.SecurityGroup(stack, "CacheAccess", { vpc });
databaseGroup.addIngressRule(tasks, ec2.Port.tcp(5432));
cacheGroup.addIngressRule(tasks, ec2.Port.tcp(6379));
tasks.addIngressRule(tasks, ec2.Port.tcp(3000));
tasks.addIngressRule(tasks, ec2.Port.tcp(3001));

const database = new rds.DatabaseInstance(stack, "Postgres", {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.of("16.13", "16"),
  }),
  instanceType: ec2.InstanceType.of(
    ec2.InstanceClass.T4G,
    ec2.InstanceSize.MICRO,
  ),
  vpc,
  vpcSubnets: isolatedSubnets,
  securityGroups: [databaseGroup],
  credentials: rds.Credentials.fromGeneratedSecret("syncbridge"),
  databaseName: "syncbridge",
  allocatedStorage: 20,
  storageEncrypted: true,
  multiAz: false,
  backupRetention: cdk.Duration.days(0),
  deleteAutomatedBackups: true,
  removalPolicy: destroy,
  cloudwatchLogsExports: [],
});
function demoSecret(id: string, length = 48, encryptionKey?: kms.IKey) {
  return new secrets.Secret(stack, id, {
    generateSecretString: {
      passwordLength: length,
      excludePunctuation: true,
    },
    removalPolicy: destroy,
    encryptionKey,
  });
}
const jwt = demoSecret("JwtSigningKey");
const keyEncryption = new kms.Key(stack, "EnvelopeKeyEncryption", {
  description: "SyncBridge demo key for Secrets Manager envelope key material",
  pendingWindow: cdk.Duration.days(7),
  removalPolicy: destroy,
});
const envelope = demoSecret("KmsProtectedEnvelopeKey", 43, keyEncryption);
const webhook = demoSecret("WebhookSigningKey");
const scheduleKey = demoSecret("SchedulerKey");
const redisKey = demoSecret("RedisPassword");
const cacheSubnets = new redis.CfnSubnetGroup(stack, "CacheSubnets", {
  description: "SyncBridge isolated cache subnets",
  subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
});
const cache = new redis.CfnReplicationGroup(stack, "Redis", {
  replicationGroupDescription: "SyncBridge single-node demo Redis",
  engine: "redis",
  engineVersion: "7.1",
  cacheNodeType: "cache.t4g.micro",
  cacheSubnetGroupName: cacheSubnets.ref,
  securityGroupIds: [cacheGroup.securityGroupId],
  numCacheClusters: 1,
  automaticFailoverEnabled: false,
  multiAzEnabled: false,
  snapshotRetentionLimit: 0,
  atRestEncryptionEnabled: true,
  transitEncryptionEnabled: true,
  authToken: redisKey.secretValue.unsafeUnwrap(),
});
cache.applyRemovalPolicy(destroy);

const table = new dynamodb.Table(stack, "WebhookEvents", {
  partitionKey: { name: "connection_id", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "event_id", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "ttl",
  removalPolicy: destroy,
});
for (const sort of ["next_attempt_at", "due_at"]) {
  table.addGlobalSecondaryIndex({
    indexName: "status-" + sort,
    partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
    sortKey: { name: sort, type: dynamodb.AttributeType.NUMBER },
  });
}

const albGroup = new ec2.SecurityGroup(stack, "DemoIngress", { vpc });
for (const port of [443, 8443])
  albGroup.addIngressRule(
    ec2.Peer.ipv4(clientCidr.valueAsString),
    ec2.Port.tcp(port),
  );
const alb = new elb.ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: true,
  vpcSubnets: publicSubnets,
  securityGroup: albGroup,
});
tasks.addIngressRule(albGroup, ec2.Port.tcp(3000));
tasks.addIngressRule(albGroup, ec2.Port.tcp(3001));
const publicApi = "https://" + alb.loadBalancerDnsName;
const publicMock = publicApi + ":8443";
const privateApi = "http://api.syncbridge.internal:3000";
const privateMock = "http://mock.syncbridge.internal:3001";
const callback = publicApi + "/oauth/callback";
const certificate = elb.ListenerCertificate.fromArn(
  certificateArn.valueAsString,
);
const apiListener = alb.addListener("ApiHttps", {
  port: 443,
  certificates: [certificate],
  open: false,
});
const mockListener = alb.addListener("MockHttps", {
  port: 8443,
  certificates: [certificate],
  open: false,
  defaultAction: elb.ListenerAction.fixedResponse(404),
});
apiListener.addAction("InternalRoute", {
  priority: 10,
  conditions: [elb.ListenerCondition.pathPatterns(["/internal/*"])],
  action: elb.ListenerAction.fixedResponse(404),
});
const image = ecs.ContainerImage.fromAsset(resolve(__dirname, ".."), {
  platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
  ignoreMode: cdk.IgnoreMode.DOCKER,
  exclude: ["infra", "infra/**"],
});
const logGroup = new logs.LogGroup(stack, "DemoLogs", {
  retention: logs.RetentionDays.ONE_DAY,
  removalPolicy: destroy,
});
const appEnv = {
  CALLBACK_URL: callback,
  PROVIDER_URL: privateMock,
  PROVIDER_BROWSER_URL: publicMock,
  WEBHOOK_TABLE_NAME: table.tableName,
  DB_HOST: database.dbInstanceEndpointAddress,
  DB_PORT: database.dbInstanceEndpointPort,
  REDIS_HOST: cache.attrPrimaryEndPointAddress,
  REDIS_PORT: cache.attrPrimaryEndPointPort,
  REDIS_TLS: "true",
  ENVELOPE_KEY_VERSION: "aws-kms-v1",
  EXTERNAL_RECONCILIATION_SCHEDULE: "true",
};
const appSecrets = {
  DB_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
  DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
  REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisKey),
  ENVELOPE_KEY: ecs.Secret.fromSecretsManager(envelope),
};

function task(
  id: string,
  command: string[],
  environment: Record<string, string>,
  secretValues: Record<string, ecs.Secret>,
  port?: number,
) {
  const definition = new ecs.FargateTaskDefinition(stack, id + "Task", {
    cpu: 256,
    memoryLimitMiB: 512,
  });
  const container = definition.addContainer(id, {
    image,
    command,
    environment,
    secrets: secretValues,
    logging: ecs.LogDrivers.awsLogs({
      logGroup,
      streamPrefix: id.toLowerCase(),
    }),
  });
  if (port) container.addPortMappings({ containerPort: port });
  return definition;
}
const apiTask = task(
  "Api",
  ["sh", "scripts/cloud-service.sh", "api"],
  appEnv,
  {
    ...appSecrets,
    JWT_SECRET: ecs.Secret.fromSecretsManager(jwt),
    WEBHOOK_KEY: ecs.Secret.fromSecretsManager(webhook),
    SCHEDULER_SECRET: ecs.Secret.fromSecretsManager(scheduleKey),
  },
  3000,
);
const workerTask = task(
  "Worker",
  ["sh", "scripts/cloud-service.sh", "worker"],
  appEnv,
  appSecrets,
);
for (const definition of [apiTask, workerTask]) {
  table.grantReadWriteData(definition.taskRole);
}
const mockTask = task(
  "Mock",
  ["node", "dist/apps/mock-provider/main.js"],
  {
    CALLBACK_URL: callback,
    WEBHOOK_TARGET: privateApi,
  },
  { WEBHOOK_KEY: ecs.Secret.fromSecretsManager(webhook) },
  3001,
);
function service(
  id: string,
  definition: ecs.FargateTaskDefinition,
  discovery?: string,
) {
  return new ecs.FargateService(stack, id, {
    cluster,
    taskDefinition: definition,
    securityGroups: [tasks],
    assignPublicIp: true,
    vpcSubnets: publicSubnets,
    desiredCount: 1,
    minHealthyPercent: 100,
    propagateTags: ecs.PropagatedTagSource.SERVICE,
    circuitBreaker: { rollback: true },
    ...(discovery
      ? {
          cloudMapOptions: {
            name: discovery,
            dnsRecordType: cdk.aws_servicediscovery.DnsRecordType.A,
          },
        }
      : {}),
  });
}
apiListener.addTargets("ApiTarget", {
  port: 3000,
  protocol: elb.ApplicationProtocol.HTTP,
  targets: [service("ApiService", apiTask, "api")],
  healthCheck: { path: "/health" },
});
service("WorkerService", workerTask);
mockListener.addTargets("SyntheticProvider", {
  port: 3001,
  protocol: elb.ApplicationProtocol.HTTP,
  priority: 10,
  conditions: [
    elb.ListenerCondition.pathPatterns(["/authorize", "/__test/events"]),
  ],
  targets: [service("SyntheticProviderService", mockTask, "mock")],
  healthCheck: { path: "/health" },
});
const tickTask = task(
  "Enqueue",
  ["node", "scripts/cloud-enqueue.mjs"],
  {
    SCHEDULER_ENDPOINT: privateApi + "/internal/reconciliation/enqueue",
  },
  { SCHEDULER_SECRET: ecs.Secret.fromSecretsManager(scheduleKey) },
);
const schedulerRole = new iam.Role(stack, "SchedulerRole", {
  assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
});
schedulerRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["ecs:RunTask"],
    resources: [tickTask.taskDefinitionArn],
    conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
  }),
);
for (const role of [tickTask.taskRole, tickTask.executionRole!])
  role.grantPassRole(schedulerRole);
const scheduleGroup = new scheduler.CfnScheduleGroup(stack, "DemoSchedules");
new scheduler.CfnSchedule(stack, "ReconciliationSchedule", {
  groupName: scheduleGroup.ref,
  scheduleExpression: "rate(1 minute)",
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: cluster.clusterArn,
    roleArn: schedulerRole.roleArn,
    retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
    ecsParameters: {
      taskDefinitionArn: tickTask.taskDefinitionArn,
      launchType: "FARGATE",
      taskCount: 1,
      propagateTags: "TASK_DEFINITION",
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "ENABLED",
          subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
          securityGroups: [tasks.securityGroupId],
        },
      },
    },
  },
});
new cdk.CfnOutput(stack, "ApiUrl", { value: publicApi });
new cdk.CfnOutput(stack, "MockUrl", { value: publicMock });
new cdk.CfnOutput(stack, "JwtSecretArn", { value: jwt.secretArn });
new cdk.CfnOutput(stack, "LogGroup", { value: logGroup.logGroupName });
