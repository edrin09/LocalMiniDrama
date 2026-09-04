import { Body, Controller, Get, Put } from '@nestjs/common';
import { AppConfigService } from './app-config.service';

@Controller()
export class AppConfigController {
  constructor(private readonly service: AppConfigService) {}

  // ===== 调度配置 =====
  @Get('scheduler-config')
  getScheduler() {
    return this.service.getScheduler();
  }

  @Put('scheduler-config')
  setScheduler(@Body() body: Record<string, any>) {
    return this.service.setScheduler(body);
  }

  // ===== AI 配置 =====
  @Get('ai-config')
  getAiConfig() {
    return this.service.getAiConfig();
  }

  @Put('ai-config')
  setAiConfig(@Body() body: Record<string, any>) {
    return this.service.setAiConfig(body);
  }
}