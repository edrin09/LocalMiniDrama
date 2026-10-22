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
  // 读取走脱敏版本：明文 Key 绝不回传前端
  @Get('ai-config')
  getAiConfig() {
    return this.service.getAiConfigForDisplay();
  }

  @Put('ai-config')
  setAiConfig(@Body() body: Record<string, any>) {
    this.service.setAiConfigFromDisplay(body);
    return this.service.getAiConfigForDisplay();
  }

  /**
   * 全局设置（合并弹窗用）：一次返回调度 + AI 两块，
   * 一次 PUT 同时保存。前端不再需要开两个弹窗、发两次请求。
   */
  @Get('settings')
  getSettings() {
    return {
      scheduler: this.service.getScheduler(),
      ai: this.service.getAiConfigForDisplay(),
    };
  }

  @Put('settings')
  setSettings(@Body() body: { scheduler?: Record<string, any>; ai?: Record<string, any> }) {
    if (body?.scheduler) this.service.setScheduler(body.scheduler);
    if (body?.ai) this.service.setAiConfigFromDisplay(body.ai);
    return this.getSettings();
  }
}