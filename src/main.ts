import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // The Next.js frontend runs on a different port (3000 vs this app's
  // 3001) even in local dev, so every request is cross-origin. Tighten
  // FRONTEND_URL before any real deployment - this is permissive for local
  // dev, same caution as ai-backend's own wide-open CORS (see
  // docs/AI_BACKEND_ENDPOINTS.md).
  app.enableCors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
