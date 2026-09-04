import {
  AIProvider,
  GenerationRequest,
  GenerationResult,
  ProviderCapability,
  ProviderTransientError,
} from './provider.types';

// 免费 TTS（微软 Edge Read Aloud 接口，无需密钥）
// 作为火山引擎 TTS 的无密钥回退：未配置 VOLC_TTS_* 时自动启用，
// 保证分镜配音始终为中文普通话，替换 AI 视频不可控的原声。
// 依赖 msedge-tts 包（CommonJS，require 直连）。
const VOICE_BY_DIALECT: Record<string, string> = {
  standard: 'zh-CN-XiaoxiaoNeural',
  zh_xian: 'zh-CN-shaanxi-XiaoniNeural',
  zh_dongbei: 'zh-CN-liaoning-XiaobeiNeural',
  zh_yueyu: 'zh-HK-HiuGaaiNeural',
  zh_chengdu: 'zh-CN-sichuan-YunxiNeural',
  zh_shanghai: 'zh-CN-Shanghai-XiaoyunNeural',
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const msEdgeTTS = require('msedge-tts');

export class EdgeTtsProvider implements AIProvider {
  readonly name = 'edge-tts';
  readonly type = 'tts' as const;

  supports(cap: ProviderCapability): boolean {
    return cap === 'tts';
  }

  /** 无需密钥，始终可用（网络不可达时由上层重试/降级处理） */
  isReady(): boolean {
    return true;
  }

  async generate(
    cap: ProviderCapability,
    req: GenerationRequest,
  ): Promise<GenerationResult> {
    if (cap !== 'tts') throw new Error(`edge-tts 不支持 ${cap} 能力`);
    const text = (req.prompt || '').trim();
    if (!text) throw new ProviderTransientError('TTS 文本为空');

    const opts = (req.options ?? {}) as {
      dialect?: string;
      voiceType?: string;
      speed?: number;
    };
    const voice =
      opts.voiceType ||
      (opts.dialect && VOICE_BY_DIALECT[opts.dialect]) ||
      'zh-CN-XiaoxiaoNeural';
    const speed = Number(opts.speed ?? 1.0);

    try {
      const tts = new msEdgeTTS.MsEdgeTTS();
      await tts.setMetadata(
        voice,
        msEdgeTTS.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      );
      const { audioStream } = tts.toStream(text, { rate: speed });
      const chunks: Buffer[] = [];
      audioStream.on('data', (d: Buffer) => chunks.push(d));
      await new Promise<void>((resolve, reject) => {
        audioStream.on('close', resolve);
        audioStream.on('error', reject);
      });
      if (!chunks.length) throw new ProviderTransientError('edge-tts 返回为空');
      return {
        status: 'success',
        b64: Buffer.concat(chunks).toString('base64'),
        raw: { voice, bytes: chunks.reduce((n, c) => n + c.length, 0) },
      };
    } catch (e: any) {
      throw new ProviderTransientError(`edge-tts 失败：${e?.message}`);
    }
  }

  async queryStatus(): Promise<GenerationResult> {
    throw new Error('edge-tts 为同步接口，无需查询任务状态');
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
