# Ride Sharing System — Build Roadmap

## About This Roadmap

Building a simplified Uber-like backend in Node.js + TypeScript. The goal is to learn
by building iteratively — each phase ships a working, testable vertical slice. No phase
introduces infrastructure that isn't justified by a concrete problem being solved.

Stack: Node.js/NestJS + TypeScript · PostgreSQL · Redis · Kafka (AWS MSK) · Docker · AWS CDK

**Local ↔ AWS service mapping**
| Local (Docker Compose) | AWS |
|---|---|
| NestJS app container | ECS Fargate (single task definition) |
| Bitnami Kafka | MSK (Kafka-compatible) |
| PostgreSQL container | RDS (PostgreSQL) |
| Redis container | ElastiCache (Redis) |

---

## Phase 0 — Scope Lock & Domain Modeling

_No code. Decisions that make or break everything else._

**Goals**

- Lock in-scope vs out-of-scope for V1
- Define the ride state machine in full
- Agree on the API surface (no more mixed naming)
- Decide communication model for customer waiting

**Steps**

1. Document the canonical ride states and valid transitions:
   `fare_created → ride_requested → matching → driver_offered → confirmed | no_driver_found | cancelled`
2. Finalize API naming — standardize on:
   - `POST /fares` — create fare estimate
   - `POST /rides` — request a ride from a fareId
   - `POST /drivers/location` — driver sends current position
   - `PATCH /rides/:rideId` — driver accepts or rejects
   - `GET /rides/:rideId/status` — rider polls for updates
   - `POST /rides/:rideId/cancel` — rider cancels
3. Decide communication model: **HTTP polling** (rider polls `/rides/:rideId/status`)
   rather than long-polling or WebSocket — simpler to implement and debug first.

**In Scope (V1)**

- Fare estimation (internal pricing stub — no third-party maps yet)
- Ride creation, Kafka-based async matching, driver accept/reject
- Driver location updates via Redis GEO
- Rider polling for ride status
- Rider cancellation

**Out of Scope (V1)**

- Ratings · scheduled rides · ride categories
- Real push notifications (APN/FCM)
- SQS / Temporal / Step Functions
- Multi-region or geographic sharding

---

## Phase 1 — Project Foundation ✅

_Every feature phase depends on this. Get it right once._

**Decisions made**

- ORM: **TypeORM** (over Prisma) — accepts more verbosity in exchange for visibility into
  queries; decorator-based entities fit NestJS DI naturally. Tradeoff: migration workflow
  requires `build → generate → run`; no `prisma migrate dev` convenience.
- Kafka dual-listener: `EXTERNAL://localhost:9092` for host-machine connections,
  `INTERNAL://kafka:29092` for container-to-container. App reads `KAFKA_BROKER` from env only.

**What was built**

1. ✅ Scaffolded with `nest new` — TypeScript, eslint, prettier included out of the box.
2. ✅ Domain modules: `RidesModule`, `DriversModule`, `FaresModule`, `HealthModule`.
   Each owns its controller, service, and TypeORM repository. Stub services ready for Phase 2+.
3. ✅ Docker Compose: postgres · redis · kafka (Bitnami KRaft, MSK-compatible) · redpanda-console.
   Dual Kafka listeners configured (`EXTERNAL`/`INTERNAL`) so `npm run start:dev` on host
   connects to `localhost:9092`; containers use `kafka:29092`.
4. ✅ TypeORM chosen. Migration tooling wired:
   - `npm run migration:generate` — generate from entity diff
   - `npm run migrate` (`migration:run`) — apply pending migrations
   - `npm run migration:revert` — roll back last migration
   - `src/database/data-source.ts` — standalone DataSource for CLI (no NestJS DI required)
5. ✅ Entities defined with indexes:
   - `riders (id uuid PK, name, email unique, phone, created_at)`
   - `drivers (id uuid PK, name, email unique, phone, is_available indexed, created_at)`
   - `fares (id uuid PK, rider_id FK, source, destination, price numeric, eta_minutes, expires_at indexed, created_at)`
   - `rides (id uuid PK, fare_id FK unique, rider_id FK, driver_id FK nullable, status enum indexed, source, destination, created_at, updated_at)`
   - Composite index on `(rider_id, status)` for active-ride lookup
   - `status` enum: `ride-status.enum.ts` — single source of truth for state machine values
6. ✅ Repository/service layer scaffolded — injectable providers, no raw SQL in controllers.
7. ✅ Global `ValidationPipe` (`whitelist: true`, `transform: true`) and global exception filter
   (`AllExceptionsFilter`) — consistent `{ statusCode, timestamp, path, message }` error shape.
8. ✅ Kafka client: `@nestjs/microservices` + `kafkajs`. Same NestJS process runs HTTP server
   and Kafka consumers (`matching-workers` consumer group registered in `main.ts`).
   Topic and consumer group names centralised in `src/kafka/kafka.constants.ts`.

**Pending verification (run on next session start)**

- `docker compose up postgres redis kafka redpanda-console`
- `npm run migration:generate && npm run migrate`
- `npm run start:dev` → `curl http://localhost:3000/health` → `200`
- Produce a test event; verify in Redpanda Console at `http://localhost:8080`

---

## Phase 2 — Fare & Ride Request Slice

_Thin vertical: rider creates a fare, then requests a ride._

**Steps**

1. `POST /fares` — accept source + destination, run internal pricing stub, persist Fare,
   return `{ fareId, price, etaMinutes }`. Fare expires after 5 minutes.
2. `POST /rides` — accept `fareId`, validate fare is unexpired and belongs to this rider,
   enforce **one active ride per rider** invariant, create Ride in `ride_requested` status.
3. `GET /rides/:rideId/status` — rider polls this during matching; returns current status
   and driver details once confirmed.

**Key Invariant**
A rider cannot have two open rides simultaneously. Enforce at the DB layer with a
conditional insert or a unique partial index on `(rider_id, status IN (active statuses))`.

**Verification**

- Creating a fare returns a fareId and sane price
- Requesting a ride with an expired fareId returns `400`
- Creating two rides for the same rider returns `409`

---

## Phase 3 — Driver Location & Availability ✅

_Parallel with Phase 2 once schema is stable._

**Decisions made**

- Redis GEO as source-of-truth for proximity (geohashing, `GEOSEARCH`). No PostGIS needed for V1.
- Postgres `drivers.is_available` as source-of-truth for availability — keeps business state
  transactional alongside ride confirmation. Tradeoff: two-hop (Redis → Postgres) per match
  attempt. Acceptable because matching is async (Kafka consumer), not on the HTTP response path.
- Stale cleanup uses a companion sorted set `driver:last_seen` (scores = Unix ms timestamps).
  `ZRANGEBYSCORE` finds all members below a threshold in O(log N + M) — the GEO set alone cannot
  do this because its scores encode geohash, not time.
- Cleanup runs as a NestJS `@Cron` (every 30s) for V1. In production: same scheduling model
  but guarded with a Redis NX lock so only one Fargate task runs it. Not RabbitMQ — this is a
  scheduled maintenance job, not an event-driven pipeline.
- Future upgrade path (when metrics justify): move availability into a Redis Set so `findNearby`
  becomes a pure Redis `GEOSEARCH` + `SINTERCARD` — eliminating the Postgres round-trip entirely.

**What was built**

1. ✅ `src/redis/redis.module.ts` — `@Global()` module providing `ioredis` client via `REDIS_CLIENT`
   injection token. Reads `REDIS_HOST` / `REDIS_PORT` from env.
2. ✅ `POST /drivers/location` — validates `{ driverId, lat, lon }`, checks driver exists in
   Postgres (404 if not), then atomically runs `GEOADD driver:locations` and
   `ZADD driver:last_seen <now> <driverId>`. Returns 204 No Content.
3. ✅ `DriversService.findNearby(lat, lon, radiusKm)` — `GEOSEARCH` → `WHERE id IN (...) AND
is_available = true` → returns distance-sorted `NearbyDriver[]`. Phase 4 ready.
4. ✅ `DriversService.setAvailability(driverId, bool)` — updates Postgres flag. Called on
   ride confirmation and cancellation in Phases 5–6.
5. ✅ `DriversCleanupService` — `@Cron(EVERY_30_SECONDS)`, `ZRANGEBYSCORE driver:last_seen -inf
<now-30s>`, then `ZREM` on both `driver:last_seen` and `driver:locations`.
6. ✅ `src/database/seed.ts` (`npm run seed`) — inserts 10 mock drivers near Mumbai into Postgres
   and registers their locations in both Redis structures.

**Verification** ✅

- `GEOSEARCH driver:locations FROMLONLAT 72.877 19.076 BYRADIUS 5 km ASC WITHDIST` returns all
  10 seeded drivers sorted by distance
- Build passes cleanly (`npm run build`)
- Stale drivers are removed from both Redis sets by the cron after 30s of inactivity

---

## Phase 4 — Ride Matching Engine

_Core of the system. Event-driven via Kafka — correctness before performance._

**Decisions made**

- Matching is async because it can take up to 60s (multiple driver offer/timeout cycles). Holding
  an HTTP connection open for that duration would be wasteful and fragile. Rider submits ride and
  polls `GET /rides/:rideId/status`.
- **Postgres is the source of truth for ride state.** Redis is a speed gate only — it prevents
  concurrent consumers from offering the same driver simultaneously. Redis correctness failures
  are non-fatal; a conditional DB update is the final arbiter.
- **Timeout ≠ rejection.** A timed-out driver is re-eligible on the next matching iteration
  (could be a network blip). An explicitly rejected driver is added to `ride:rejected:<rideId>`
  Redis set and permanently skipped for this ride.
- To prevent burning the full 60s budget on a repeatedly unresponsive driver: track timeout count
  in `ride:timed_out:<rideId>` (Redis hash, `driverId → count`). If count ≥ 2 for a driver on
  this ride, treat as rejected and skip.
- The retry loop has no `while` or sleeping thread. Instead: on each failure (timeout, reject,
  all candidates busy) the consumer re-publishes `ride.requested` to Kafka. Each message is one
  iteration. The `matching_deadline` timestamp on the Ride row is the 60s escape hatch checked
  at the top of every iteration.
- Late-accept guard: driver calling `PATCH /rides/:rideId` validates `ride.status == driver_offered`,
  `ride.offered_driver_id == driverId`, and `now < offer_expires_at`. Any mismatch returns 410.
- All status transitions use a conditional `WHERE status = <expected>` update. Whoever wins gets
  rowcount = 1; the loser discards silently. This resolves cancel/accept race conditions.

**Schema additions to `rides` table**

- `matching_deadline TIMESTAMPTZ` — set to `now + 60s` on ride creation
- `offered_driver_id UUID FK nullable` — driver currently being offered the ride
- `offer_expires_at TIMESTAMPTZ nullable` — set to `now + 10s` when offer is made

**Redis keys**

- `driver:lock:<driverId>` — NX lock (TTL 10s), prevents double-offering a driver across consumers
- `ride:rejected:<rideId>` — SET of driverIds who explicitly rejected this ride (TTL 120s)
- `ride:timed_out:<rideId>` — HASH of `driverId → timeout_count` (TTL 120s)

**Event Flow**

```
POST /rides  →  INSERT ride (status: ride_requested, matching_deadline: now+60s)
                →  publish ride.requested
                →  return { rideId, status: ride_requested }  [rider starts polling]
                    ↓
         [matching-workers consumer]
                    ↓
              check matching_deadline — if elapsed → no_driver_found, DONE
                    ↓
         GEOSEARCH → filter rejected + high-timeout-count drivers
                    ↓
         SET driver:lock:<driverId> NX PX 10000
                    ↓
         UPDATE ride { status: driver_offered, offered_driver_id, offer_expires_at: now+10s }
                    ↓
         [driver polls pending offer endpoint, sees the offer]
                    ↓
         PATCH /rides/:rideId { decision: accept | reject }
                    ↓
         publish driver.response
                    ↓
         [ride-confirmation consumer]
```

**Steps**

1. `POST /rides` — validate fareId, enforce one-active-ride-per-rider invariant, INSERT Ride with
   `{ status: ride_requested, matching_deadline: now+60s }`. Publish `ride.requested`. Return
   `{ rideId, status: ride_requested }` immediately.
2. Matching consumer receives `ride.requested`:
   - Check `now > matching_deadline` → UPDATE `no_driver_found`, DONE.
   - `GEOSEARCH` within 5km, filter `is_available = true`.
   - Filter out drivers in `ride:rejected:<rideId>` and those with timeout count ≥ 2.
   - Attempt `SET driver:lock:<driverId> <rideId> NX PX 10000` on closest candidate.
   - Lock acquired → UPDATE ride `{ status: driver_offered, offered_driver_id, offer_expires_at }`. Exit.
   - Lock failed → try next candidate. All candidates locked/skipped → re-publish `ride.requested`, exit.
3. Offer timeout cron (`@Cron` every 5s) — finds rides where `status = driver_offered AND offer_expires_at < now`.
   For each: `HINCRBY ride:timed_out:<rideId> <driverId> 1`, DEL `driver:lock:<driverId>`,
   UPDATE ride `{ status: ride_requested, offered_driver_id: null, offer_expires_at: null }`,
   re-publish `ride.requested`.
4. `PATCH /rides/:rideId` — driver sends `{ decision: accept | reject }`. Validate status,
   `offered_driver_id`, and `offer_expires_at`. Publish `driver.response`.
5. Ride confirmation consumer receives `driver.response`:
   - **Accept**: UPDATE ride `{ status: confirmed, driver_id }`, UPDATE driver `{ is_available: false }`,
     DEL `driver:lock`, DEL `ride:rejected` and `ride:timed_out` (cleanup).
   - **Reject**: `SADD ride:rejected:<rideId> <driverId>`, DEL `driver:lock`,
     UPDATE ride `{ status: ride_requested, offered_driver_id: null }`, re-publish `ride.requested`.

**Cancellation interactions**

- Cancel during `ride_requested`: UPDATE `{ status: cancelled }` — straightforward.
- Cancel during `driver_offered`: conditional UPDATE `WHERE status = driver_offered`,
  DEL `driver:lock`, `SADD ride:rejected` (driver freed). On success UPDATE `{ status: cancelled }`.
- Cancel after `confirmed`: return 400 — out of scope for V1.
- Race (cancel + accept in-flight): both use conditional update; one gets rowcount = 1, the other discards.

**Consumer Group Strategy**

- `matching-workers` — processes `ride.requested`; scales horizontally (one worker per Kafka partition).
- `ride-confirmation` — processes `driver.response`.
- Redis NX lock ensures no two `matching-workers` instances offer the same driver concurrently.

**Verification**

- `ride.requested` event visible in Redpanda Console after `POST /rides`
- Matching consumer picks the closest available driver
- Two concurrent consumers cannot both lock the same driver
- Rejected driver does not receive a second offer on the same ride
- Timed-out driver IS re-offered on the next iteration (unless timed out ≥ 2 times)
- Late accept after `offer_expires_at` returns 410
- `no_driver_found` ride row updated when `matching_deadline` elapses

---

## Phase 5 — Driver Accept / Reject & Ride Confirmation

_Complete the loop: rider gets a confirmed ride or failure response._

**Steps**

1. `PATCH /rides/:rideId` — driver sends `{ decision: "accept" | "reject" }`.
   Handler validates that the driver is the one currently locked for this ride,
   then publishes a `driver.response` event (topic: `driver.response`).
2. Ride confirmation consumer (`consumer group: ride-confirmation`) consumes `driver.response`.
   - On **accept**: atomically transition ride to `confirmed`, set `driver_id`, mark driver
     `is_available = false`, release Redis lock. Rider's next poll returns `confirmed` + driver details.
   - On **reject**: release Redis lock, publish a `ride.requested` retry event so the
     matching consumer re-enters the offer loop with the next candidate.
3. Timeout handling — if driver does not respond within 10s (Redis TTL expires),
   the matching consumer detects the failed lock renewal and moves to the next candidate
   without waiting for a `driver.response` event.

**Verification**

- Rider polling after acceptance returns `status: confirmed` with driver name
- Reject triggers re-matching and the next available driver is offered the ride
- A driver that is already `is_available = false` cannot receive a second offer
- `driver.response` events are visible in Kafka UI

---

## Phase 6 — Cancellation & Edge Cases

_Correctness under failure scenarios._

**Steps**

1. `POST /rides/:rideId/cancel` — cancel a ride when status is `ride_requested` or `matching`.
   If a driver has already been offered (`driver_offered`), release the Redis lock and mark
   the driver available again. Cancellation after `confirmed` is out of scope for V1.
2. Handle the race: cancellation arrives while accept/reject is in-flight — use a DB
   transaction with a status check to ensure only one transition wins.
3. Fare expiry cleanup — background job or trigger to mark fares `expired` after TTL.

**Verification**

- Cancelling a ride in `matching` state releases the driver lock
- Cancelling after `confirmed` returns a clear error (not silently failing)
- Concurrent cancel + accept resolves to exactly one final state

---

## Phase 7 — Dockerize & Deploy to AWS (CDK)

_Local parity verified first. CDK mirrors Docker Compose exactly._

**Local verification (pre-deploy)**

1. `Dockerfile` for the NestJS app — multi-stage build (build stage + lean runtime stage).
2. Confirm `docker compose up` runs all four containers cleanly end-to-end:
   app · Postgres · Redis · Kafka. Run the full ride flow against local containers.
3. Environment variable strategy: `.env` locally, AWS Secrets Manager / SSM Parameter Store in prod.
   App reads from `process.env` only — no env-specific code paths.

**CDK stack (TypeScript)** 4. Bootstrap CDK in target AWS account (`cdk bootstrap`). 5. `InfraStack` — provisions:

- VPC with public + private subnets
- RDS PostgreSQL (private subnet, Security Group allows Fargate only)
- ElastiCache Redis (private subnet, same SG approach)
- MSK cluster (multi-AZ, `kafka.t3.small` for dev) with the same topic names and consumer groups used locally
- ECS Cluster + Fargate task definition pointing to the app image in ECR
- Application Load Balancer → Fargate service

6. ECR repository — push the NestJS Docker image, reference the image URI in the task definition.
7. Run DB migrations as a one-off ECS task (same image, different command: `npm run migrate`).
8. Deploy: `cdk deploy`. Smoke-test the ALB endpoint.

**Key decisions**

- Consumers run inside the same Fargate task as the HTTP server — no separate EC2 or Lambda needed.
  Scaling Fargate desired count = scaling Kafka consumer group members automatically.
- CDK stack lives in `infra/` at the repo root, versioned alongside app code.
- Dev and prod are separate CDK stacks (`InfraStack-dev`, `InfraStack-prod`) sharing the same constructs.

**Verification**

- `cdk diff` shows no unintended drift
- ALB health check hits `GET /health` → `200`
- Produce a `ride.requested` event via API; MSK consumer processes it and ride row updates in RDS
- Fargate task logs visible in CloudWatch

---

## Phase 9 — Controlled Expansion (Post-MVP)

_Only introduce this complexity when metrics justify it._

| Trigger                        | Upgrade                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| Driver notification lag        | Integrate APN / FCM push notifications                      |
| Routes and ETA needed          | Swap pricing stub for real Maps API                         |
| Redis single-node risk         | Add Redis Sentinel or Redis Cluster                         |
| Geographic hotspots            | Increase Kafka partition count; partition by geohash region |
| Matching throughput ceiling    | Scale `matching-workers` consumer group horizontally on MSK |
| Complex retry/timeout behavior | Introduce Temporal workflow                                 |

---

## Ride State Machine Reference
