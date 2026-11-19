# SyncBridge CDK deployment evidence

## Preflight

AWS STS verified the account ending in **4638**. The configured and selected region is **ca-central-1**. The read-only console was already accepted.

## Pre-deploy cost estimate

Budget **US$4.00 for a six-hour demo**, including contingency. The same assumptions give a conservative **US$11.00 for 24 hours**, below the US$25 cutoff. Estimates use on-demand pricing, exclude credits, and assume minimal synthetic traffic and immediate teardown.

| Item | Conservative planning allowance | Six hours |
| --- | ---: | ---: |
| Three Linux Fargate tasks at 0.25 vCPU and 0.5 GiB each, plus scheduled one-off tasks | $0.075/hour total | $0.45 |
| ALB, up to one LCU | $0.045/hour | $0.27 |
| Up to six public IPv4 addresses, including ALB interfaces and a scheduled task | $0.030/hour | $0.18 |
| Single-AZ PostgreSQL db.t4g.micro and 20 GiB storage | $0.045/hour | $0.27 |
| Single-node ElastiCache cache.t4g.micro | $0.040/hour | $0.24 |
| DynamoDB, ECR, S3, logs, DNS discovery, Scheduler, secrets, KMS and small transfer | $1.50 for the run | $1.50 |
| **Subtotal** | | **$2.91** |

The hourly allowances round up rather than claiming an exact regional quote. Fargate tasks use public subnets with security groups and outbound access for image pulls and AWS APIs. PostgreSQL and Redis use isolated subnets. The ALB uses two AZs as required. The database and cache each have one node. No NAT gateway is required.

Pricing references: [Fargate](https://aws.amazon.com/fargate/pricing/), [ALB](https://aws.amazon.com/elasticloadbalancing/pricing/), [IPv4](https://aws.amazon.com/vpc/pricing/), [RDS PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [ElastiCache](https://aws.amazon.com/elasticache/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/), and [EventBridge](https://aws.amazon.com/eventbridge/pricing/).

## Bootstrap, synth and diff

The default CDK toolkit stack was absent. CDK bootstrapped the dedicated `SyncBridgeDemoToolkit` stack with qualifier `syncbdemo` and the project and ephemeral tags. No deployment or lookup trustees were added.

The TypeScript check and `cdk synth SyncBridgeDemo` exited successfully. The template contains 77 CloudFormation resources. The three ECS services have these ALB attachments:

~~~text
API                   1
Worker                0
Synthetic provider    1
~~~

`cdk diff SyncBridgeDemo --method template` exited successfully and reported one new stack. The diff contained 83 addition lines, including parameters and outputs, with zero modification or removal lines. The additions included a single HTTPS ALB listener, two target groups, one PostgreSQL instance, one Redis replication group, one on-demand DynamoDB table, and one EventBridge schedule.

EventBridge Scheduler starts a one-off Fargate task that calls the private API enqueue route with an injected scheduler secret. The public ALB blocks that route. VPC private DNS connects the API and mock service to the worker. The operator smoke client pins the temporary ACM certificate. The synthetic provider's public allowlist covers authorization and the fixture-delivery route. Its token and resource endpoints stay inside the VPC.

ECS injects Secrets Manager references. A dedicated KMS key protects the envelope wrapping key in Secrets Manager. The application wraps payload data keys with that injected, versioned key. The KMS key is scheduled for deletion when the stack is destroyed.
