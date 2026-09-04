import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app-config/app-config.module';
import { AIProviderFactory } from './ai-provider.factory';
import { FfmpegService } from './ffmpeg.service';
import { PromptService } from './prompt.service';
import { RateLimitService } from './rate-limit.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    AIProviderFactory,
    RateLimitService,
    StorageService,
    PromptService,
    FfmpegService,
  ],
  exports: [
    AIProviderFactory,
    RateLimitService,
    StorageService,
    PromptService,
    FfmpegService,
  ],
})
export class AiModule {}
