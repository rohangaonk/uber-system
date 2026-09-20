# Test Expectations — Ride Sharing System

A scenario-by-scenario reference for manual (and later automated) testing.
Each section maps directly to an endpoint, background job, or async consumer.

> **Prerequisites** (before any scenario below)
>
> - `docker compose up postgres redis kafka redpanda-console -d`
> - `npm run migrate`
> - `npm run seed` (inserts 10 drivers near Mumbai — lat 19.076, lon 72.877)
> - `npm run start:dev`
> - Have at least one rider UUID handy (insert manually or note from DB)
>
> ```sql
> INSERT INTO riders (id, name, email, phone)
> VALUES (gen_random_uuid(), 'Test Rider', 'rider@test.com', '9999999999')
> RETURNING id;
> ```

---

## 1. Health Check

| #   | Scenario      | Request       | Expected               |
| --- | ------------- | ------------- | ---------------------- |
| 1.1 | Service is up | `GET /health` | `200 { status: "ok" }` |

---

## 2. Driver Location Update — `POST /drivers/location`

### 2.1 Happy Path

| #     | Scenario                           | Request Body                                                   | Expected                                                              |
| ----- | ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2.1.1 | Valid location update              | `{ driverId: <seeded-driver-uuid>, lat: 19.076, lon: 72.877 }` | `204 No Content`                                                      |
| 2.1.2 | Same driver updates location again | Same driverId with new lat/lon                                 | `204 No Content` (idempotent — overwrites previous position in Redis) |
| 2.1.3 | Boundary coordinates               | `lat: 90, lon: 180`                                            | `204 No Content`                                                      |

### 2.2 Validation Errors

| #     | Scenario          | Bad Input                | Expected          |
| ----- | ----------------- | ------------------------ | ----------------- |
| 2.2.1 | Unknown driverId  | Valid UUID not in DB     | `404 Not Found`   |
| 2.2.2 | lat below range   | `lat: -91`               | `400 Bad Request` |
| 2.2.3 | lat above range   | `lat: 91`                | `400 Bad Request` |
| 2.2.4 | lon below range   | `lon: -181`              | `400 Bad Request` |
| 2.2.5 | lon above range   | `lon: 181`               | `400 Bad Request` |
| 2.2.6 | Missing driverId  | Omit driverId            | `400 Bad Request` |
| 2.2.7 | Non-UUID driverId | `driverId: "not-a-uuid"` | `400 Bad Request` |
| 2.2.8 | Missing lat       | Omit lat                 | `400 Bad Request` |
| 2.2.9 | Missing lon       | Omit lon                 | `400 Bad Request` |

### 2.3 Side Effects to Verify (Redis)

After a successful 2.1.1:

```
GEOSEARCH driver:locations FROMLONLAT 72.877 19.076 BYRADIUS 1 km ASC
# → should include the driverId

ZSCORE driver:last_seen <driverId>
# → should return a recent Unix ms timestamp
```

---

## 3. Fare Creation — `POST /fares`

### 3.1 Happy Path

| #     | Scenario             | Request Body                                                             | Expected                                                                    |
| ----- | -------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 3.1.1 | Valid fare creation  | `{ riderId, source, destination, sourceLat: 19.076, sourceLon: 72.877 }` | `201 { fareId, price, etaMinutes, expiresAt }`                              |
| 3.1.2 | Price range check    | Any valid request (run a few times)                                      | `price` is between 60 (1km) and 350 (30km); always `50 + (distanceKm × 10)` |
| 3.1.3 | ETA check            | Any valid request                                                        | `etaMinutes` equals `distanceKm × 2` (2–60 min range)                       |
| 3.1.4 | Expiry check         | Any valid request                                                        | `expiresAt` is ~5 minutes after creation time                               |
| 3.1.5 | Boundary coordinates | `sourceLat: -90, sourceLon: -180`                                        | `201` successfully                                                          |

### 3.2 Validation Errors

| #      | Scenario                | Bad Input         | Expected          |
| ------ | ----------------------- | ----------------- | ----------------- |
| 3.2.1  | Missing riderId         | Omit riderId      | `400 Bad Request` |
| 3.2.2  | Non-UUID riderId        | `riderId: "abc"`  | `400 Bad Request` |
| 3.2.3  | Missing source          | Omit source       | `400 Bad Request` |
| 3.2.4  | Source > 500 chars      | 501-char string   | `400 Bad Request` |
| 3.2.5  | Missing destination     | Omit destination  | `400 Bad Request` |
| 3.2.6  | Destination > 500 chars | 501-char string   | `400 Bad Request` |
| 3.2.7  | Missing sourceLat       | Omit sourceLat    | `400 Bad Request` |
| 3.2.8  | sourceLat out of range  | `sourceLat: 91`   | `400 Bad Request` |
| 3.2.9  | Missing sourceLon       | Omit sourceLon    | `400 Bad Request` |
| 3.2.10 | sourceLon out of range  | `sourceLon: -181` | `400 Bad Request` |

> **Known Gap**: `riderId` is not validated against the `riders` table. POST /fares with a random, non-existent UUID will still return `201`. This is something to be aware of during testing.

---

## 4. Ride Creation — `POST /rides`

> **Setup**: Create a fare first (section 3) and note the `fareId`.

### 4.1 Happy Path

| #     | Scenario            | Request Body                                                       | Expected                                                                                                                             |
| ----- | ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1.1 | Valid ride creation | `{ fareId: <fresh-fareId>, riderId: <same-riderId-used-in-fare> }` | `201 { rideId, status: "ride_requested" }`                                                                                           |
| 4.1.2 | Kafka event emitted | After 4.1.1                                                        | `ride.requested` event visible in Redpanda Console (port 8080) with `{ rideId, riderId, source, destination, sourceLat, sourceLon }` |
| 4.1.3 | DB state            | After 4.1.1                                                        | Row in `rides` table with `status = ride_requested`, `matching_deadline` ~60s in future, `offered_driver_id = NULL`                  |

### 4.2 Validation & Business Rule Errors

| #     | Scenario                      | Bad Input                                                                            | Expected                                                                            |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 4.2.1 | Non-existent fareId           | Random UUID not in `fares` table                                                     | `404 Not Found`                                                                     |
| 4.2.2 | Wrong riderId                 | fareId created by rider A, but riderId = rider B                                     | `403 Forbidden`                                                                     |
| 4.2.3 | Expired fare                  | fareId whose `expires_at` is in the past                                             | `400 Bad Request` (message: "FARE_EXPIRED")                                         |
| 4.2.4 | Rider already has active ride | Submit a second POST /rides with the same riderId while first is in `ride_requested` | `409 Conflict` (message includes existing rideId)                                   |
| 4.2.5 | Same fareId used twice        | Submit POST /rides twice with identical body                                         | First → `201`; second → `409` (active ride guard fires before DB unique constraint) |
| 4.2.6 | Missing fareId                | Omit field                                                                           | `400 Bad Request`                                                                   |
| 4.2.7 | Missing riderId               | Omit field                                                                           | `400 Bad Request`                                                                   |
| 4.2.8 | Non-UUID fareId               | `fareId: "bad"`                                                                      | `400 Bad Request`                                                                   |
| 4.2.9 | Non-UUID riderId              | `riderId: "bad"`                                                                     | `400 Bad Request`                                                                   |

### 4.3 One-Active-Ride-Per-Rider Invariant

| #     | Scenario                                      | Steps                                                                        | Expected                                       |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| 4.3.1 | Rider can request new ride after cancellation | Cancel ride A → create fare B → POST /rides with rider                       | `201` (cancelled status not counted as active) |
| 4.3.2 | Rider blocked during `driver_offered`         | While matching is in progress (status = driver_offered), attempt second ride | `409 Conflict`                                 |
| 4.3.3 | Rider unblocked after `no_driver_found`       | Wait for matching deadline to expire → create new fare → POST /rides         | `201` (no_driver_found is not active)          |

---

## 5. Ride Status Polling — `GET /rides/:rideId/status`

| #   | Scenario                | State                          | Expected Response                                                                                          |
| --- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 5.1 | Ride just created       | `ride_requested`               | `{ rideId, status: "ride_requested", driver: null }`                                                       |
| 5.2 | Driver has been offered | `driver_offered`               | `{ rideId, status: "driver_offered", driver: null }` (driver field is `null` — driver_id not yet assigned) |
| 5.3 | Ride confirmed          | `confirmed`                    | `{ rideId, status: "confirmed", driver: { name, phone } }`                                                 |
| 5.4 | No driver found         | `no_driver_found`              | `{ rideId, status: "no_driver_found", driver: null }`                                                      |
| 5.5 | Ride cancelled          | `cancelled`                    | `{ rideId, status: "cancelled", driver: null }`                                                            |
| 5.6 | Non-existent rideId     | Random UUID                    | `404 Not Found`                                                                                            |
| 5.7 | Invalid UUID format     | `GET /rides/not-a-uuid/status` | `400 Bad Request`                                                                                          |

---

## 6. Matching Engine (Async — Kafka Consumer)

> These scenarios require the full stack running. Trigger by creating a ride and watching side effects.

### 6.1 Normal Matching Flow

| #     | Scenario                    | Setup                                                     | Expected                                                                                                     |
| ----- | --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 6.1.1 | Driver nearby and available | Seed driver at 19.076, 72.877; create ride at same coords | Within ~1s: ride transitions to `driver_offered`; `offered_driver_id` set; `offer_expires_at` ~10s in future |
| 6.1.2 | Driver lock set in Redis    | After 6.1.1                                               | `GET driver:lock:{offeredDriverId}` returns the rideId with ~10s TTL                                         |
| 6.1.3 | Closest driver is picked    | Multiple drivers at different distances                   | `offered_driver_id` should match the driver with the smallest distance from source coords                    |

### 6.2 No Candidates

| #     | Scenario                       | Setup                                                                       | Expected                                                                                                           |
| ----- | ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 6.2.1 | No drivers within 5km          | Create ride at coordinates far from all seeded drivers (e.g., lat 0, lon 0) | `ride.requested` re-emitted on loop; ride stays `ride_requested` until matching_deadline; then → `no_driver_found` |
| 6.2.2 | All nearby drivers unavailable | Set all drivers `is_available = false` in DB before creating ride           | Same as 6.2.1 — infinite retry until deadline                                                                      |
| 6.2.3 | All nearby drivers locked      | Another ride already holds all locks                                        | Same loop behaviour                                                                                                |

### 6.3 Deadline & Timeout

| #     | Scenario                                             | Expected                                                                                                  |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 6.3.1 | Matching deadline elapsed at loop start              | If 60s pass with no driver found, ride → `no_driver_found`; no further Kafka messages published           |
| 6.3.2 | Status after deadline                                | `GET /rides/:rideId/status` → `{ status: "no_driver_found", driver: null }`                               |
| 6.3.3 | Deadline only fires if status still `ride_requested` | Conditional update `WHERE status = ride_requested` prevents overwriting a `confirmed` or `cancelled` ride |

### 6.4 Idempotency & Race Conditions

| #     | Scenario                                                  | Expected                                                                                                                                   |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.4.1 | Duplicate `ride.requested` message (Kafka at-least-once)  | Second consume: ride status is `driver_offered` → idempotency guard skips processing silently                                              |
| 6.4.2 | Two matching-workers consume same message                 | Both attempt `SET driver:lock:{driverId} NX`; only one acquires; DB conditional update means only one transitions the ride; other discards |
| 6.4.3 | Consumer crashes after lock acquired but before DB update | Lock TTL expires in 10s → timeout cron reclaims within next 5s tick                                                                        |

---

## 7. Driver Response — `PATCH /rides/:rideId`

> Represents driver calling accept or reject on their pending offer.

### 7.1 Happy Path

| #     | Scenario       | Request Body                                          | Expected                                                                     |
| ----- | -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| 7.1.1 | Driver accepts | `{ driverId: <offeredDriverId>, decision: "accept" }` | `204 No Content`; `driver.response` event in Kafka with `decision: "accept"` |
| 7.1.2 | Driver rejects | `{ driverId: <offeredDriverId>, decision: "reject" }` | `204 No Content`; `driver.response` event in Kafka with `decision: "reject"` |

### 7.2 Error Cases

| #     | Scenario                           | Bad Input                                 | Expected                            |
| ----- | ---------------------------------- | ----------------------------------------- | ----------------------------------- |
| 7.2.1 | Non-existent rideId                | Random UUID                               | `404 Not Found`                     |
| 7.2.2 | Ride not in `driver_offered` state | Status is `ride_requested` or `confirmed` | `410 Gone` (offer no longer active) |
| 7.2.3 | Wrong driverId                     | driverId is not the `offered_driver_id`   | `410 Gone` (not the offered driver) |
| 7.2.4 | Offer already expired              | Call after `offer_expires_at` has passed  | `410 Gone` (offer expired)          |
| 7.2.5 | Invalid decision value             | `decision: "maybe"`                       | `400 Bad Request`                   |
| 7.2.6 | Missing driverId                   | Omit field                                | `400 Bad Request`                   |
| 7.2.7 | Missing decision                   | Omit field                                | `400 Bad Request`                   |
| 7.2.8 | Non-UUID driverId                  | `driverId: "abc"`                         | `400 Bad Request`                   |
| 7.2.9 | Invalid UUID in path               | `PATCH /rides/not-a-uuid`                 | `400 Bad Request`                   |

---

## 8. Ride Confirmation Consumer (Accept Path)

> Triggered when `driver.response` event with `decision: "accept"` is consumed.

| #   | Scenario                                                 | Expected                                                                                                                                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Accept processed successfully                            | `rides.status = confirmed`, `rides.driver_id = driverId`, `rides.offered_driver_id = null`, `rides.offer_expires_at = null`                                    |
| 8.2 | Driver availability updated                              | `drivers.is_available = false` for accepted driver                                                                                                             |
| 8.3 | Redis cleanup                                            | `driver:lock:{driverId}` deleted; `ride:rejected:{rideId}` deleted; `ride:timed_out:{rideId}` deleted                                                          |
| 8.4 | Rider polling sees confirmation                          | `GET /rides/:rideId/status` → `{ status: "confirmed", driver: { name, phone } }`                                                                               |
| 8.5 | Stale accept (race: ride cancelled before consumer runs) | Conditional update (`WHERE status = driver_offered AND offered_driver_id = driverId`) gets `affected = 0`; consumer logs "lost the race" and discards silently |
| 8.6 | Duplicate `driver.response` message (Kafka retry)        | Same as 8.5 — second consume finds status already `confirmed`; discarded                                                                                       |

---

## 9. Ride Confirmation Consumer (Reject Path)

> Triggered when `driver.response` event with `decision: "reject"` is consumed.

| #   | Scenario                                              | Expected                                                                                                                                               |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9.1 | Reject processed successfully                         | `driverId` added to `ride:rejected:{rideId}` set; `driver:lock:{driverId}` deleted; ride status reset to `ride_requested`; `ride.requested` re-emitted |
| 9.2 | Rejected driver not offered again                     | Matching consumer reads `ride:rejected:{rideId}` and skips that driver on all future iterations                                                        |
| 9.3 | Next available driver gets offer                      | After rejection, matching consumer picks the next closest eligible driver                                                                              |
| 9.4 | Stale reject (offer timed out before reject consumed) | Conditional DB update `affected = 0`; consumer discards. `SADD ride:rejected` still runs (minor Redis side-effect, harmless since 120s TTL)            |
| 9.5 | All drivers reject                                    | Each rejection triggers re-matching; when no more eligible drivers exist → loop continues until matching_deadline → `no_driver_found`                  |

---

## 10. Offer Timeout Cron (every 5 seconds)

> Handles rides where `status = driver_offered` AND `offer_expires_at < now`.

| #    | Scenario                                      | Expected                                                                                                                                                       |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 | Driver doesn't respond within 10s             | Cron detects expired offer; `HINCRBY ride:timed_out:{rideId} {driverId} 1`; `DEL driver:lock:{driverId}`; ride → `ride_requested`; `ride.requested` re-emitted |
| 10.2 | Driver timed out once — still eligible        | Matching consumer reads `ride:timed_out` count = 1 < 2 (MAX); driver is still offered                                                                          |
| 10.3 | Driver timed out twice — permanently skipped  | Timeout count ≥ 2; matching consumer skips this driver for this ride (treated same as explicit rejection)                                                      |
| 10.4 | Race: driver accepts while cron is processing | Cron's conditional update `WHERE status = driver_offered AND offered_driver_id = driverId` gets `affected = 0`; cron skips this ride                           |
| 10.5 | Race: ride cancelled while cron is processing | Same conditional update check; `affected = 0`; cron skips                                                                                                      |
| 10.6 | `offeredDriverId` is null                     | Cron skips this record and logs a warning (guard exists in code)                                                                                               |

---

## 11. Ride Cancellation — `POST /rides/:rideId/cancel`

### 11.1 Happy Path

| #      | Scenario                       | Ride Status      | Expected                                                                                                                                        |
| ------ | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1.1 | Cancel during `ride_requested` | `ride_requested` | `204`; `rides.status = cancelled`; `ride:rejected` and `ride:timed_out` keys deleted                                                            |
| 11.1.2 | Cancel during `matching`       | `matching`       | `204`; same as 11.1.1 _(Note: no code currently transitions to `matching` status, so this state may be untestable in practice)_                 |
| 11.1.3 | Cancel during `driver_offered` | `driver_offered` | `204`; driver freed (`is_available = true`); `driver:lock:{driverId}` deleted; `ride:rejected` + `ride:timed_out` deleted; status = `cancelled` |

### 11.2 Error Cases

| #      | Scenario                  | Ride Status       | Expected          |
| ------ | ------------------------- | ----------------- | ----------------- |
| 11.2.1 | Already confirmed         | `confirmed`       | `410 Gone`        |
| 11.2.2 | Already cancelled         | `cancelled`       | `410 Gone`        |
| 11.2.3 | Already `no_driver_found` | `no_driver_found` | `410 Gone`        |
| 11.2.4 | Non-existent rideId       | —                 | `404 Not Found`   |
| 11.2.5 | Invalid UUID in path      | —                 | `400 Bad Request` |

### 11.3 Race Conditions

| #      | Scenario                                                 | Expected                                                                                                                                                     |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11.3.1 | Cancel during `driver_offered` while accept is in-flight | Cancel uses `pessimistic_write` DB lock; conditional update `WHERE status IN (...)` means exactly one of cancel/accept wins; loser gets `affected = 0` → 410 |
| 11.3.2 | Cancel wins the race                                     | Driver lock may or may not be deleted by cancel depending on timing; confirmation consumer's accept sees `affected = 0` and discards safely                  |
| 11.3.3 | Accept wins the race                                     | Ride transitions to `confirmed`; cancel call returns `410 Gone`                                                                                              |

---

## 12. Driver Cleanup Cron (every 30 seconds)

> Evicts drivers who haven't sent a location update in the last 30 seconds.

| #    | Scenario                                       | Expected                                                                                                       |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 12.1 | Driver goes silent for 30s+                    | Removed from `driver:locations` and `driver:last_seen` in Redis; `is_available` in Postgres is **NOT changed** |
| 12.2 | Cleaned driver no longer found by `findNearby` | `GEOSEARCH driver:locations` no longer returns that driver; matching will not offer them a ride                |
| 12.3 | Driver re-registers location after cleanup     | `POST /drivers/location` re-adds them to both Redis sets; they immediately become eligible for matching again  |
| 12.4 | No stale drivers                               | Cron runs and finds no entries below threshold → exits early, no Redis writes                                  |

---

## 13. End-to-End Flows

### 13.1 Happy Path — Full Ride Cycle

```
1.  POST /fares                                  → 201 { fareId }
2.  POST /rides with fareId                      → 201 { rideId, status: ride_requested }
3.  [Kafka] ride.requested consumed              → DB: status = driver_offered, offered_driver_id set
4.  GET /rides/:rideId/status                    → { status: driver_offered }
5.  PATCH /rides/:rideId (accept)                → 204
6.  [Kafka] driver.response consumed (accept)    → DB: status = confirmed, driver_id set; driver.is_available = false
7.  GET /rides/:rideId/status                    → { status: confirmed, driver: { name, phone } }
```

### 13.2 Driver Rejects Once, Second Driver Accepts

```
1.  POST /fares → POST /rides                    → ride_requested
2.  Matching offers Driver A                     → driver_offered (Driver A)
3.  PATCH /rides (Driver A rejects)              → driver.response (reject)
4.  [Consumer] removes Driver A from offered;    → ride_requested; Driver A in rejected set
    re-emits ride.requested
5.  Matching offers Driver B                     → driver_offered (Driver B)
6.  PATCH /rides (Driver B accepts)              → driver.response (accept)
7.  [Consumer] confirms ride                     → confirmed (Driver B)
8.  GET /rides/:rideId/status                    → confirmed + Driver B details
```

### 13.3 Offer Times Out, Driver Re-offered Once, Then Gets Skipped

```
1.  POST /fares → POST /rides                    → ride_requested
2.  Matching offers Driver A                     → driver_offered (Driver A); lock set
3.  Driver A does not respond for 10s
4.  [Cron] offer expires                         → ride:timed_out{Driver A} = 1; lock deleted; ride_requested; re-emit ride.requested
5.  Matching offers Driver A again (count < 2)   → driver_offered (Driver A)
6.  Driver A does not respond again
7.  [Cron] offer expires                         → ride:timed_out{Driver A} = 2; ride_requested; re-emit
8.  Matching skips Driver A (count ≥ 2)          → tries next candidate
```

### 13.4 Rider Cancels During Matching

```
1.  POST /fares → POST /rides                    → ride_requested
2.  Matching offers Driver A                     → driver_offered (Driver A)
3.  POST /rides/:rideId/cancel                   → 204; Driver A freed; locks cleaned; cancelled
4.  [Concurrent] driver.response arrives         → conditional update affected = 0; discarded
5.  GET /rides/:rideId/status                    → { status: cancelled }
```

### 13.5 All Drivers Unavailable → No Driver Found

```
1.  Mark all drivers is_available = false in DB
2.  POST /fares → POST /rides                    → ride_requested
3.  Matching loops, GEOSEARCH returns drivers     → all filtered by is_available check → eligible = []
4.  Re-emit ride.requested continues until       matching_deadline (60s)
5.  After deadline                               → no_driver_found
6.  GET /rides/:rideId/status                    → { status: no_driver_found, driver: null }
```

### 13.6 Fare Expiry Boundary

```
1.  POST /fares                                  → 201 { fareId, expiresAt }
2.  Wait for expiresAt to pass (5 minutes)
3.  POST /rides with expired fareId              → 400 { message: "FARE_EXPIRED: ..." }
```

---

## 14. Data Integrity Checks (SQL Assertions)

Run these queries after each major scenario to verify DB state:

```sql
-- All rides and their current state
SELECT id, status, offered_driver_id, driver_id, matching_deadline, offer_expires_at
FROM rides ORDER BY created_at DESC;

-- Fares and expiry
SELECT id, rider_id, price, eta_minutes, expires_at FROM fares ORDER BY created_at DESC;

-- Driver availability
SELECT id, name, is_available FROM drivers;

-- Active rides per rider (should never be > 1)
SELECT rider_id, COUNT(*) as active_count
FROM rides WHERE status IN ('ride_requested', 'matching', 'driver_offered')
GROUP BY rider_id HAVING COUNT(*) > 1;
-- ↑ should return 0 rows
```

---

## 15. Redis State Checks

```bash
# All driver locations (should have entries for seeded + recently updated drivers)
redis-cli ZRANGE driver:locations 0 -1

# All driver last_seen timestamps
redis-cli ZRANGE driver:last_seen 0 -1 WITHSCORES

# Active driver lock for a specific driver
redis-cli GET driver:lock:<driverId>

# Rejected drivers for a ride
redis-cli SMEMBERS ride:rejected:<rideId>

# Timeout counts for a ride
redis-cli HGETALL ride:timed_out:<rideId>
```

---

## 16. Known Gaps / Intentional Non-Scope

These are **not defects** but things to be aware of during testing:

| Gap                                              | Notes                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matching` status never set                      | The enum has it, the active-ride guard checks for it, but no code transitions a ride to `matching`. Treat `ride_requested` as the "matching in progress" state. |
| `riderId` not validated on `POST /fares`         | A fare can be created with a non-existent riderId. POST /rides with a valid fare + correct riderId will still work.                                             |
| Stale cleanup doesn't set `is_available = false` | A silent driver stays `is_available = true` in Postgres for up to 30s before geo eviction.                                                                      |
| `driver.offered` and `ride.failed` Kafka topics  | Defined in constants but never published.                                                                                                                       |
| Cancellation after `confirmed`                   | Returns `410` — intentionally out of scope for V1.                                                                                                              |
