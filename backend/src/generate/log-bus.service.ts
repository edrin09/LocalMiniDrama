import { Injectable } from '@nestjs/common';
import { Observable, Subject, map } from 'rxjs';

// 内存事件总线：按分集(episodeId)维护订阅集合，供生成引擎广播日志/状态事件，由 SSE 转发给前端。
// 轻量组件，无持久化；生成任务都是短生命周期，无需落库。
export interface GenEvent {
  type: 'log' | 'storyboard' | 'asset' | 'merge' | 'phase' | 'done' | 'error';
  // log: { level:'info'|'success'|'warn'|'error', text, at }
  // storyboard: { id, status, progress, imageUrl?, lastFrameUrl?, videoUrl? }
  // asset: { kind:'character'|'scene'|'prop', id, imageUrl?, sourceUrl? }
  // phase: 整剧/整集流水线阶段的阶段切换（供前端进度流程图定位）
  //   { scope:'drama'|'episode', episodeId, episodeTitle?, stepId, stepLabel, percent }
  // merge: { progress, url? }
  data: any;
}

@Injectable()
export class LogBusService {
  private episodes = new Map<number, Subject<GenEvent>>();
  private dramas = new Map<number, Subject<GenEvent>>();

  subscribe(episodeId: number): Observable<string> {
    const subject = this.getSubject(this.episodes, episodeId);
    return subject.asObservable().pipe(map((e) => JSON.stringify(e)));
  }

  /** 整剧级生成日志流：按 dramaId 订阅（配合 generate-all / 整剧成片进度页） */
  subscribeDrama(dramaId: number): Observable<string> {
    const subject = this.getSubject(this.dramas, dramaId);
    return subject.asObservable().pipe(map((e) => JSON.stringify(e)));
  }

  emit(episodeId: number, event: GenEvent) {
    const subject = this.episodes.get(episodeId);
    if (subject) subject.next(event);
  }

  /** 整剧级广播 */
  emitDrama(dramaId: number, event: GenEvent) {
    const subject = this.dramas.get(dramaId);
    if (subject) subject.next(event);
  }

  /** 兼容：生成引擎内部已按 episodeId emit，这里也同步转发到 dramaId 通道 */
  emitBoth(episodeId: number, dramaId: number, event: GenEvent) {
    this.emit(episodeId, event);
    this.emitDrama(dramaId, event);
  }

  private getSubject(map: Map<number, Subject<GenEvent>>, key: number): Subject<GenEvent> {
    let subject = map.get(key);
    if (!subject) {
      subject = new Subject<GenEvent>();
      map.set(key, subject);
    }
    return subject;
  }
}