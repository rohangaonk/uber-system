export const KAFKA_TOPICS = {
  RIDE_REQUESTED: 'ride.requested',
  DRIVER_OFFERED: 'driver.offered',
  DRIVER_RESPONSE: 'driver.response',
  RIDE_FAILED: 'ride.failed',
} as const;

export const KAFKA_CONSUMER_GROUPS = {
  MATCHING_WORKERS: 'matching-workers',
  RIDE_CONFIRMATION: 'ride-confirmation',
} as const;
