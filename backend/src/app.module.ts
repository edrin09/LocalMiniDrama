import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health/health.controller';
import { DramaModule } from './drama/drama.module';
import { EpisodeModule } from './episode/episode.module';
import { AppConfigModule } from './app-config/app-config.module';
import { ScriptModule } from './script/script.module';
import { GenerateModule } from './generate/generate.module';
import { UploadModule } from './upload/upload.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [joinEnvPath()],
    }),
    PrismaModule,
    AiModule,
    DramaModule,
    EpisodeModule,
    ScriptModule,
    GenerateModule,
    UploadModule,
    AppConfigModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

// .env 位于项目根目录（backend 上一级），向上找
function joinEnvPath() {
  const path = require('path');
  return path.join(process.cwd(), '..', '.env');
}