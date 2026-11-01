# Backend scalability plan

**Recommendation:** load-test one Worker + one D1 database on Paid, with suitable
paid API plans, to validate these workloads and identify bottlenecks. Use isolated
test data and explicit traffic/spend limits; testing and purchases need separate approval.

## Expected workload: explicit assumptions

Activity matters more than registered users. At one checkout per active user/day,
the scenarios correspond to 100/1,000/10,000 daily active users; lower conversion
means a larger user base for the same load.

| Planning envelope                          | Created checkouts/day | Peak new checkouts/min | Simultaneous visible carts | Simultaneous active checkout tabs |
| ------------------------------------------ | --------------------: | ---------------------: | -------------------------: | --------------------------------: |
| Small demo                                 |                   100 |                      1 |                          5 |                                 5 |
| Shared demo                                |                 1,000 |                     10 |                         20 |                                30 |
| Growth sensitivity, not supported capacity |                10,000 |                     60 |                        100 |                               200 |

Assume one creation, four reference-price reads, 25 status reads, two wallet metadata
requests and one submission per checkout: **33 application requests + up to 28 preflights**.
Use a 30-day month, with retries, abuse and other account consumers additional.

## 1. External APIs: costs and scaling

### Jupiter and Solana

Jupiter supplies SOL/USD prices. Price v3 costs one credit/request; paid overage
is $1/million credits. Quotas are shared across the organisation over a sliding
60-second window, including both reference reads and checkout creation.

| Jupiter tier | Monthly subscription | Main quota/min |  Included credits/month |
| ------------ | -------------------: | -------------: | ----------------------: |
| Free API key |                   $0 |             60 | Unlimited, rate-limited |
| Developer    |                  $25 |            600 |              25 million |
| Launch       |                 $100 |          3,000 |             100 million |
| Pro          |                 $500 |          9,000 |             500 million |

Solana RPC checks the network, prepares wallet metadata and verifies transactions.
The configured provider is unverified; Phantom handles broadcasting separately.
Public Devnet RPC is free but shared, changeable and not a capacity guarantee.
Published limits include 100 requests/10 seconds/IP and 40/method/10 seconds/IP.
These figures came from the official indexed page after direct retrieval returned
429; reconfirm before relying on them. Devnet can reset.

### Helius: a Devnet RPC option

Helius replaces the Solana RPC provider, **not Jupiter**. Only standard RPC is
needed; no streaming or enhanced APIs are assumed.

| Helius tier  | Monthly subscription | Included credits/month | RPC requests/sec |
| ------------ | -------------------: | ---------------------: | ---------------: |
| Free         |                   $0 |              1 million |               10 |
| Developer    |                  $49 |             10 million |               50 |
| Business     |                 $499 |            100 million |              200 |
| Professional |                 $999 |            200 million |              500 |

The billing page prices the methods used here at one credit each. Its RPC index
conflicts, listing `getTransaction` at ten: verify metering before purchasing.
Additional credits cost $5/million but do not raise RPS. Paid-card autoscaling
can add charges (Business/Professional default on); agree a spend cap first.

### What each workload needs

Each checkout uses five Jupiter reads and five RPC calls before retries.
Monthly volume for each is `30 × 5 × daily checkouts`.
Jupiter peak demand is `2 × visible carts + peak creations/min` (30-second cart
refreshes); RPC peak demand is `5 × peak creations/min`, before retries.

| Checkouts/day | Monthly credits per provider* | Jupiter peak/min | RPC peak/min | Candidate external subscriptions/month                    |
| ------------- | ----------------------------: | ---------------: | -----------: | --------------------------------------------------------- |
| 100           |                        15,000 |               11 |            5 | $0: both Free                                             |
| 1,000         |                       150,000 |               50 |           50 | $0 if quotas fit; $25 with Jupiter Developer for headroom |
| 10,000        |                     1,500,000 |              260 |          300 | $74: Jupiter Developer + Helius Developer                 |

\* Helius at one credit/call. At ten credits per transaction lookup, its totals
become 42,000/420,000/4,200,000; the same candidate plans still fit before retries.
Each extra verification adds two RPC calls (two or eleven Helius credits).
Minute rates do not prove peak-second RPS fit; scheduled retries add up to 20 calls/min.

**When to scale:** review provider 429s, sustained usage above 50% of rate quota,
or projected monthly credits above 80% of allowance. Reduce redundant reference
refreshes, then evaluate pacing or a higher plan. At 1,000/day Jupiter already
uses 83% of Free's minute quota. Paid providers do not remove application limits.

## 2. Internal platform: one Worker + one D1 database

**One scalable API service, one shared database.** The Worker handles concurrent
requests; D1 executes queries serially per database. There is no verified
checkouts/day ceiling: query speed, polling, retries and storage determine capacity.

### Plans and limits

| Resource        | Free             | Paid                                   |
| --------------- | ---------------- | -------------------------------------- |
| Worker requests | 100,000/day      | 10M/month included                     |
| HTTP CPU        | 10 ms/invocation | 30 s default; configurable up to 5 min |
| D1 reads        | 5M rows/day      | 25B rows/month included                |
| D1 writes       | 100,000 rows/day | 50M rows/month included                |
| D1 storage      | 500 MB/database  | 10 GB/database; 5 GB/account included  |

Workers Paid starts at **$5/account/month**, including 30M CPU-ms. Overage:
$0.30/M requests, $0.02/M CPU-ms; D1 $0.001/M reads, $1/M writes, $0.75/GB-month.
Allowances are shared account-wide; Free quota exhaustion is not automatic paid overage.

### Illustrative monthly costs

Assume **5 ms CPU/invocation, 1,000 billed reads and 200 billed writes/checkout**,
storage within 5 GB and logs within allowance. These are unmeasured placeholders,
not upper bounds. With `P` daily checkouts, invocations are `30 × (61 × P + 1440)`
including preflights and minutely Cron; retry processing adds usage.

| Checkouts/day | Invocations/month | D1 writes/month | Worker cost | D1 usage cost | Internal total |
| ------------- | ----------------: | --------------: | ----------: | ------------: | -------------: |
| 100           |           226,200 |         600,000 |       $5.00 |         $0.00 |          $5.00 |
| 1,000         |         1,873,200 |       6,000,000 |       $5.00 |         $0.00 |          $5.00 |
| 10,000        |        18,343,200 |      60,000,000 |       $8.74 |        $10.00 |         $18.74 |

The small scenario could instead cost $0 on Free if measured CPU/quotas fit.
At 1,000/day, assumed writes already exceed Free. External APIs, frontend hosting
and taxes are excluded from this table.

### What limits this combo?

| Limitation                                                                        | When to change something                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker CPU and shared account quotas                                              | Near limits: profile/reduce work, then evaluate Paid or configured limits.                                                                  |
| One D1 database serializes queries; each status poll writes two counters          | Slow queries/overload: reduce polling, optimize queries/indexes. Split only if measured pressure persists; replicas do not remove writes.   |
| D1 storage: 10 GB maximum on Paid                                                 | At 70% full, plan reconciled archival/migration. At an assumed 4 KiB/checkout, 10,000/day adds 1.23 GB/month. Do not purge payment history. |
| Retry scheduler: ten candidate attempts/minute, not ten settlements               | Persistent backlog or overlapping runs: review provider delays and safe bounded dispatch.                                                   |
| Application caps: reference and metadata each 60/min globally; general 180/IP/min | Growth exceeds both global caps: reduce duplicate calls, then review limits against provider budgets. More Workers do not fix this.         |

**10,000/day:** a plausible Paid target for this combo, not validated capacity.
Validate the combo under Paid through load tests measuring peak load, query latency,
storage and retry recovery. Hosted tests or infrastructure changes need separate approval.
Preserve the payment guarantees in [architecture](architecture.md) and
[security boundaries](SECURITY.md), including the 15-minute quote / 24-hour review window.

## Sources

- Cloudflare: [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [limits](https://developers.cloudflare.com/d1/platform/limits/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).
- Jupiter: [plans/credits](https://developers.jup.ag/docs/portal/plans), [pricing](https://developers.jup.ag/pricing), [rate limits](https://developers.jup.ag/docs/portal/rate-limits).
- Solana: [public RPC limits](https://solana.com/docs/references/clusters).
- Helius: [plans](https://www.helius.dev/docs/billing/plans), [billing credits](https://www.helius.dev/docs/billing/credits), [conflicting RPC index](https://www.helius.dev/docs/api-reference/rpc/http/llms.txt), [rate limits](https://www.helius.dev/docs/billing/rate-limits), [additional credits](https://www.helius.dev/docs/billing/additional-credits), [Devnet FAQ](https://www.helius.dev/docs/faqs).
- Implementation: [routes/counters](../src/index.ts), [payments/retries](../src/payments.ts), [pricing](../src/price.ts), [RPC proxy](../src/checkout-rpc.ts), [verification](../src/solana.ts), [schema](../migrations/0001_payments.sql).
