import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app-config/app-config.service';
import { AgnesProvider } from './agnes.provider';
import { VolcengineProvider } from './volcengine.provider';
import { EdgeTtsProvider } from './edge-tts.provider';
import { AIProvider, ProviderCapability } from './provider.types';

// Provider 工厂：注册 / 热拔插 / 按能力解析（开发文档 §五）
@Injectable()
export class AIProviderFactory {
  private readonly providers = new Map<string, AIProvider>();

  constructor(private readonly appConfig: AppConfigService) {
    this.build();
    // 换 Key / 换模型后自动重建 provider，无需重启后端
    this.appConfig.onChange(() => this.build());
  }

  /** 按当前配置重建全部 provider（供测试与显式刷新调用） */
  reload() {
    this.build();
  }

  private build() {
    // 第一步注册 Agnes 三件套，后续平台按需 register() 挂载
    this.register(new AgnesProvider(this.readAgnesConfig()));
    // 火山引擎 TTS（配音）：无密钥时 isReady()=false，上层走模拟降级
    this.register(new VolcengineProvider(this.readVolcConfig()));
    // 免费 edge-tts（微软 Edge Read Aloud）：无密钥回退，保证配音始终中文
    this.register(new EdgeTtsProvider());
  }

  register(provider: AIProvider) {
    this.providers.set(provider.name, provider);
  }

  get(name?: string): AIProvider {
    const cfgDefault = this.appConfig.getAiConfig().defaultProvider;
    const key = name || cfgDefault || 'agnes';
    const p = this.providers.get(key);
    if (!p) throw new Error(`未注册的 AI Provider：${key}`);
    return p;
  }

  /** 取一个支持该能力且已配置 Key 的 provider，优先默认 provider */
  resolve(cap: ProviderCapability): AIProvider {
    const preferred = this.tryGet(this.appConfig.getAiConfig().defaultProvider);
    if (preferred?.supports(cap) && preferred.isReady()) return preferred;
    for (const p of this.providers.values()) {
      if (p.supports(cap) && p.isReady()) return p;
    }
    throw new Error(`没有可用且已配置密钥的 ${cap} Provider`);
  }

  /** 当前默认 provider 是否已接入（决定走真实生成还是模拟降级） */
  isLive(cap: ProviderCapability): boolean {
    try {
      return this.resolve(cap).isReady();
    } catch {
      return false;
    }
  }

  list() {
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      type: p.type,
      ready: p.isReady(),
      // 展示当前生效的模型，避免「配置里填了 A、实际在用 B」无从察觉
      models:
        p instanceof AgnesProvider
          ? p.currentModels()
          : Object.fromEntries(
              (this.appConfig.getAiConfig() as any).providers?.[p.name]?.models ?? {},
            ),
    }));
  }

  private tryGet(name?: string): AIProvider | null {
    return name ? this.providers.get(name) ?? null : null;
  }

  /** Agnes 配置：界面配置的 Key/BaseURL/模型 优先于 .env */
  private readAgnesConfig() {
    const cfg = this.appConfig.getAiConfig() as any;
    const providerCfg = cfg.providers?.agnes ?? {};
    return {
      baseUrl: providerCfg.baseUrl || process.env.AGNES_BASE_URL || undefined,
      apiKey: providerCfg.apiKey || process.env.AGNES_API_KEY || undefined,
      models: providerCfg.models || undefined,
    };
  }

  /** 火山 TTS 配置：界面配置的凭据 优先于 .env */
  private readVolcConfig() {
    const tts = (this.appConfig.getAiConfig() as any).tts ?? {};
    return {
      appId: tts.appId || process.env.VOLC_TTS_APP_ID || undefined,
      token: tts.token || process.env.VOLC_TTS_TOKEN || undefined,
      cluster: tts.cluster || process.env.VOLC_TTS_CLUSTER || undefined,
      defaultVoice: tts.defaultVoice || process.env.VOLC_TTS_VOICE_TYPE || undefined,
    };
  }
}
