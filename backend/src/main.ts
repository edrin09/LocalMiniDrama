import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';

// 素材根目录由 .env 指定（相对 backend 工作目录），确保目录存在
const uploadDir = process.env.UPLOAD_DIR || '../data/uploads';
const absUpload = join(process.cwd(), uploadDir);

async function bootstrap() {
  if (!existsSync(absUpload)) {
    mkdirSync(absUpload, { recursive: true });
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 参考图以 base64 Data URI 走 JSON 上传，放开默认 100kb 限制
  app.useBodyParser('json', { limit: '20mb' });

  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 素材目录静态托管：/uploads/xxx
  app.useStaticAssets(absUpload, {
    prefix: '/uploads/',
  });

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  const url = await app.getUrl();
  console.log(`[LocalMiniDrama] backend ready at ${url}`);
  console.log(`[LocalMiniDrama] uploads dir: ${absUpload}`);
}
bootstrap();