import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { KAFKA_CONSUMER_GROUPS } from './kafka/kafka.constants';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // Kafka microservice — only connect when KAFKA_ENABLED=true.
  // Phase 2 produces no Kafka events; skip to avoid a hard crash when Kafka is not running.
  // Set KAFKA_ENABLED=true before Phase 4 (matching engine).
  if (process.env.KAFKA_ENABLED === 'true') {
    // matching-workers: consumes ride.requested
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.KAFKA,
      options: {
        client: {
          clientId: 'uber-system-matching',
          brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'],
        },
        consumer: { groupId: KAFKA_CONSUMER_GROUPS.MATCHING_WORKERS },
      },
    });
    // ride-confirmation: consumes driver.response
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.KAFKA,
      options: {
        client: {
          clientId: 'uber-system-confirmation',
          brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'],
        },
        consumer: { groupId: KAFKA_CONSUMER_GROUPS.RIDE_CONFIRMATION },
      },
    });
    await app.startAllMicroservices();
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
