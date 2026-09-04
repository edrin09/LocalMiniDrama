import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app-config/app-config.service';
import { ProviderAuthError } from './provider.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 轻量信号量：控制同类任务的并发数
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * 生成任务调度：并发控制 + 视频限频 + 指数退避重试 + 鉴权熔断
 * 对应开发文档 §3.3 与计划 §六「限频保护 / 重试与熔断」
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private imageSem?: Semaphore;
  private videoSem?: Semaphore;
  private lastVideoStart = 0;
  /** 熔断标记：鉴权/配额故障后置位，避免持续盗刷额度 */
  private circuitOpen = false;
  private circuitReason = '';

  constructor(private readonly appConfig: AppConfigService) {}

  private cfg() {
    return this.appConfig.getScheduler();
  }

  private semaphore(kind: 'image' | 'video') {
    const cfg = this.cfg();
    if (kind === 'image') {
      this.imageSem ??= new Semaphore(
        Math.max(1, cfg.max_image_concurrency ?? 3),
      );
      return this.imageSem;
    }
    this.videoSem ??= new Semaphore(
      Math.max(1, cfg.max_video_concurrency ?? 2),
    );
    return this.videoSem;
  }

  isCircuitOpen() {
    return this.circuitOpen;
  }

  circuitMessage() {
    return this.circuitReason;
  }

  resetCircuit() {
    this.circuitOpen = false;
    this.circuitReason = '';
  }

  /** 并发安全的排队执行：图片走并发上限，视频额外按最小间隔排队 */
  async schedule<T>(kind: 'image' | 'video', fn: () => Promise<T>): Promise<T> {
    this.assertClosed();
    return this.semaphore(kind).run(async () => {
      if (kind === 'video') await this.waitVideoSlot();
      try {
        return await fn();
      } finally {
        // 无论成功失败，视频配额都从「发起时刻」起算
      }
    });
  }

  /** 指数退避 + Jitter 重试；鉴权/配额错误直接熔断不重试 */
  async withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delayMs: number, reason: string) => void,
  ): Promise<T> {
    const cfg = this.cfg();
    const maxRetries = Math.max(0, cfg.max_retries ?? 5);
    const initDelay = cfg.retry_initial_delay_ms ?? 1000;
    const maxDelay = cfg.retry_max_delay_ms ?? 30000;

    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e: any) {
        if (e instanceof ProviderAuthError) {
          this.circuitOpen = true;
          this.circuitReason = e.message;
          this.logger.error(`[熔断] ${label}：${e.message}`);
          throw e;
        }
        const retryable = e instanceof Error && e.name === 'ProviderTransientError';
        if (!retryable || attempt >= maxRetries) throw e;

        const delay = Math.min(
          initDelay * 2 ** attempt + Math.random() * 1000,
          maxDelay,
        );
        attempt++;
        onRetry?.(attempt, Math.round(delay), e.message);
        await sleep(delay);
      }
    }
  }

  private async waitVideoSlot() {
    const interval = Math.max(0, this.cfg().video_min_interval_ms ?? 60000);
    if (interval === 0) return;
    const wait = this.lastVideoStart + interval - Date.now();
    if (wait > 0) {
      this.logger.log(`视频接口限频，等待 ${Math.round(wait / 1000)}s 后发起`);
      await sleep(wait);
    }
    this.lastVideoStart = Date.now();
  }

  private assertClosed() {
    if (this.circuitOpen) {
      throw new ProviderAuthError(`生成已熔断：${this.circuitReason}`);
    }
  }
}
