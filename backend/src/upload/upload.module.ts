import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';

// StorageService / PromptService 来自 @Global 的 AiModule，无需重复导入
@Module({
  controllers: [UploadController],
})
export class UploadModule {}
