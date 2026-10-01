import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // The Next.js frontend is a different origin from this API (local dev:
  // :3000 vs :3001; production: <project>.vercel.app vs api.<ip>.sslip.io),
  // so every request is cross-origin. FRONTEND_URL is the one allowed origin
  // (or a comma-separated list); never a wildcard - this API takes Bearer
  // tokens from the browser.
  const origins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  app.enableCors({ origin: origins });
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
