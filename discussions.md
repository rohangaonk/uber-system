Ride Sharing System Design
### Requirements

- user should be able to choose a source and destination and book a ride.
- user should see a list of cab options based on his input.
- user should see real time driver location on the map and expected time of pickup.
- User should be able to cancel a ride
- Driver should receive notification once customer has selected a ride
- Driver should be able to accept of reject a ride

Hello Interview

- Rider should be able to enter source and destination and get fare estimates
- Rider should be able to request a ride on the estimated fare.
- Upon request, rider should be matched with driver who is nearby and available
- Driver should be able to accept/reject and navigate to pickup

Out of scope

- Riders should be able to rate the driver
- Driver should be able to rate passengers
- Riders should be able to reschedule rides in advance
- Riders should be able to choose a category of rides (x, xl, comfort)

### Non Functional Requirements

- No 2 users should be matched with the same driver at same time - consistent
- User can only have one active open request at a time.

Scale

- 2 million active drivers.
- 100 million rides a day ⇒ 1k rides per second
- users should be matched with drivers in 3 seconds.
- fair estimate should be less than 1s.
- generic api latency 10-100ms. eg. ride cancellation, ride rejection

Hello Interview

- System should prioritise low latency matching (< 1 minute to match or failure)
- Strong consistency in ride matching. prevent a driver from multiple simultaneous rides.
- Handle high throughput during peak hours or special events (100k requests from same location)

out of line

- secure driver and user data complying with regulations like GDPR.
- resilient to failures with redundancy and failover mechanism in place.
- Robust monitoring, logging, alerting to resolve issue.
- system should facilitate easy updates (ci/ci pipeline)

### Core Entitites

- Rider - user who books a ride
- Driver - user who accept a ride
- Fare - estimate amount of a ride
- Ride - entity which has user, driver, vehicle, path details with timestamps
- Location - storing real time driver locations including last update timestamp.

### Api and System Interface

- GET  /api/estimate?source={source}&dest={destination} ⇒ {amount: number, fareId}
- POST /api/match   body {source, destination, estimatedFare, estimateId} ⇒ {status: true, driverDetails: {name, number, vehicle number, type}, rideId} ⇒ ride object with status = pending
- POST /api/confirm/ride/{rideId} ⇒ ride status = user_confirmed
- POST /api/driver/confirm/{rideId} ⇒ ride status = confirmed. or rejected if driver rejects

Hello Interview

- Get fare endpoint
    - POST /fare  → Fare
    - Body {pickupLocation, destination}
    - response {FareId}
    - Used post because we will be creating fare entity in the database.
- Request ride endpoint
    - POST /rides →Ride
    - Body {FareId}
    - initiates ride match process, created ride object
- Endpoint for drivers to update their location
    - POST drivers/location
    - Body: {lat, long}
- Accept Ride request
    - allow drivers to accept a ride
    - upon acceptance updates ride status and gives driver ride details
    - PATCH /rides/:rideId → Ride
    - Body: {accept or deny}

### High Level Design

![Interview (2).jpg](attachment:0c9a28e0-f2ae-4658-a871-8e0d2a0bcc31:Interview_(2).jpg)

Hello interview

![Interview (3).jpg](attachment:24dcc76d-68a4-4f8b-abf0-2539e217853e:Interview_(3).jpg)

Step 1 requesting for a fare estimate

- gateway handles auth, rate-limiting, routing etc.
- ride service calls third party maps api to get the location/path details and then use companies pricing model to estimate the fare and eta. pricing model internals is out of scope.
- Fare {id, userId, source, destination, price, eta}

Step 2 accept ride based on fare

- Ride table is created at this point
- Ride {rideId, riderId, driverId, fareId, source, destination, status, timestamps}
- stauts is requested.

Step 3 now system needs to match riders with drivers

- we need a service to update driver location.
- riders update their locations regularly with update location endpoint
- matching service uses these locations to determine closest available match

Step 4 driver should be able to accept or decline and then accordingly proceed to pickup.

- we need one additional service to notify drivers. Notification service is responsible for dispatching real time notifications to drivers when ride is matched to them.
- Notifications are sent via APN (Apple push notifications) or FCM(firebase cloud messageing)
- **Important thing to remember** is that ride matching service sends real time notifications to the top ranked/nearby/available driver.
- now driver has 2 choices; 1. accept in which case we patch the ride object with status as accepted and customer is notified via same match request that ride is confirmed. (remember that customer has requested a match and is waiting for system response. no notification is in play here customer is sent response in same request.)
- if driver declines the request system sends notification to the next ranked driver and so on.
- Now once driver accept he gets ride details and can proceed to pickup

One question from my side here

- customer has requested match → ride match workflow started → drivers receive notification → they accept or reject → so in this case i have assumed that customers have open tcp connection and are still waiting for the response (long polling). (we have 1 minute buffer). is my assumption correct?

### Deep Dives

1. How to handle frequent driver location updates and efficient proximity searches on location?
- my points rough estimate before looking at the solution
    - we have assumed that there are 1 million active drivers in the system.
    - each driver updates his location per 5 seconds. ⇒ 1m/5 = 200k updates per second.
    - (given it is a light endpoint we may have a single go/node server can handle 20k request per second so we will need 10-15 api instances. postgres well tuned db support writes at lets say 10k wps ⇒ 20-25 instances with sharding on driver id).
    - Can we improve this? 20 db instances is definitely not the right path.
    - Batch updates and periodically flush them to db every 5 seconds. this can work but now worst case for any driver will be 10s delay in updating location. (this can work). we have reduced load by 5x to 40k wps that is 4-5 db nodes with sharding on driver id.
    - How batching would work is that api instance will push location update event to kafka
    - consumer will listen for the topic lets say driver_location so in this case the actual service which produces events can handle around 20k updates. so we need few instances of this service. Kafka can handle millions of writes so that is not a problem.
    - we can divide topics to partitions such that we have n number of consumers. But we ultimately need to write this data to database. right now i can think of a database which should support hight write throughput. Cassandra can be used in this place and we can tune it to be eventually consistent to support high writes and manageable reads.
    - i am still debating on postgres/cassandra because i also need high reads but not at the scale at which writes will happen.
    - lets think about read throughput for driver location. we have 100 million rides a day that is 1k rides per second. peak will be 10k rides per second lets say.
    - 10 reads per second are manageable with cassandra

Hello Interview.

- 2 important problems we need to solve. 1. High frequency writes and 2. Query efficiency
- He says 10 million drivers *(i assumed 1 million active per day)* sending location every 5 seconds. ⇒ 2 million updates a second (i was slightly off but that is fine)
- Postgres or dynamo db are good choices for rest of the system but for this functionality they either will fail under the load or need scaling so high that it becomes very expensive.
- without proper query optimisation for getting drivers within a radius we will need to scan entire driver calculate distance for each driver  and get the list. (not feasible). Even with indexing on lat and long this is not feasible because b-tree indexes are not suited for multi-dimensional data like geo points.

Bad solution

- direct update of location to db and doing proximity searches directly on db would definitely lead to failure of system at load.

Good solution

- updates are batch processed, then specialised geospatial database with proper indexing for proximity search
- geospatial dbs use **quad trees**  to index driver locations.
- postgres has plugin called as PostGIS which support geospatial data types and functions.
- Batching has one drawback that is delay in updating driver location. which may not be ideal

Great solution

- The idea is to use something like **redis** for geospatial data types and commands.
- This help us to efficiently update driver locations and proximity searches with high throughput and low latency.
- redis also has ttl which helps us in expiration of stale location data.
- redis uses something called as geohashing to encode lat and long
- Redis has GEOADD (adding a location) and GEOSEARCH (query nearby locations) which efficiently handle real time driver location updates and proximity searches.
- we do not need batch processing because redis can handle high volume updates in real time.
- handling stale data when driver goes offline can be handled by periodic cleanup process that removes drivers whose last updated timestamp exceeds 30s threshold. One approach is to maintain a companion sorted set keyed by timestamp and periodically remove entries older than the threshold from both the timestamp set and geo set.
- One challenge here is persistence if redis node goes down. ⇒ 2 possible solutions
    - Redis persistence: we can enable redis persistence like RDB (redis database) or AOF (append only file) to periodically save data to disk.
    - Redis sentinel: high availability with automatic failover.
- That being said impact of data loss would be minimal since updates come every 5 seconds.

1. How can we manage system overload from frequent driver location updates while ensuring location accuracy?
- address this by implementing adaptive location update intervals.
- we can use ondevice sensors to determine optimal interval for sending updates. we can use factors like, speed, direction of travel, proximity to pending requests and driver status.

1. How do we prevent multiple ride requests from being sent to the same driver simultaneously?
    
    Bad solution
    
    - application level lock → this will not work because there is no central cordination in multi instance system
    
    Good Solution
    
    - database level lock → update status in db to say outstanding_request so that no other instance can lock this row. use interval to release the lock in application code. lot of problems like deadlock scenario if instance crashes after locking.
    
    Great solution
    
    - Distributed lock with in-memory store like redis with ttl
    - when ride is requested we apply lock with a driverId with ttl of say 10s. Now if other instance try to apply lock for same driver they will not be able to do so. we manually release the lock if driver accepts or TTL takes care if it expires.
    - one challenge is systems reliance on the availability and performance of in memory db for locking. we need robust monitoring and failover strategy. but given we have locks only for 10s this is not a big problem.
    
2. How can we ensure no ride requests are dropped during peak demand periods?
- during peak hours system may receive high volume of requests
- when ride match requests come in we send them in a queue. the ride matching service can then process each requests and based on queue depth we can scale the system dynamically.
- also a possibility of partitioning queue based on geographic regions.
- Kafka can be used as a distributed queue system. commit offset only after successful match found. so now even if ride matching service goes down match request is still in the queue and new instance can pick it up.
- but this increases complexity. we can use few scalable managed, fault-tolerant, highly available options are **AWS SQS, AWS MSK**, etc.
- other issue is because it is FIFO we may have few requests which take more time to process(or stuck)which affect other requests in queue. → can be addressed with priority queue based on factors like driver proximity, driver rating.

1. What happens if driver fails to respond in a timely manner?
    - One solution is to use Durable execution. a framework like **Temporal** or aws step functions.
    - they provide built in support for retries, timeouts and state management in a way that survives service crashes and restarts.
    - Ex. Temporal workflow would be
        - send the ride request to the first driver
        - set 10 second timeout
        - if accepted complete workflow
        - else declines or times out then move to next driver
        - continue till all drivers are exhausted.
    - the entire process is fault tolerant and can handle network failure and other issues without loosing state.
    
2. How can you further scale system to reduce latency and improve throghput?
    - Horizontal scaling by adding more servers.
    - sharding our data **geographically becuase since this is a ride sharing system we will benefit greatly with geographical sharding in almost all the services**
    - we can shard driver locations using redis geohash based sharding to reduce single hot node queries. One care that needs to take in this case is handling boundaries. we can handle boundary proximity queries by gathering neghbouring cells and including them in the result. (doable in redis with geohash)