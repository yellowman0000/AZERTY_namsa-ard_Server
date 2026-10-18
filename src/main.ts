import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // enable CORS for Next.js (localhost:3000) to make requests
  app.enableCors({
    origin: ['http://localhost:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // เปิดใช้งาน Validation อัตโนมัติ (เผื่อ Wuth ใช้ทำ Payload Validation)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(3001);
  console.log(`Kiosk Backend is running on: http://localhost:3001`);
}
void bootstrap();