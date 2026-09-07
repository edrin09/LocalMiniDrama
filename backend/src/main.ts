import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { AppModule } from './app.module';

// 崩溃兜底日志：进程被异常终止前把堆栈落盘，避免「无声消失」无法取证
const crashLog = (kind: string, e: any) => {
  try {
    appendFileSync(
      join(process.cwd(), 'crash.log'),
      `\n[${new Date().toISOString()}] ${kind}: ${e?.stack ?? e}\n`,
    );
  } catch {
    /* 兜底自身失败时只能放弃 */
  }
};
process.on('uncaughtException', (e) => crashLog('uncaughtException', e));
process.on('unhandledRejection', (e) => crashLog('unhandledRejection', e));

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