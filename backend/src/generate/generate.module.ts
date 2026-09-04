import { Module } from '@nestjs/common';
import { GenerateController } from './generate.controller';
import { GenerateService } from './generate.service';
import { LogBusService } from './log-bus.service';
import { TextEnrichService } from './text-enrich.service';

@Module({
  controllers: [GenerateController],
  providers: [GenerateService, LogBusService, TextEnrichService],
  exports: [LogBusService],
})
export class GenerateModule {}
