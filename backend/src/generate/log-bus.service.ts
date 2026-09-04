import { Injectable } from '@nestjs/common';
import { Observable, Subject, map } from 'rxjs';

// 内存事件总线：按分集(episodeId)维护订阅集合，供生成引擎广播日志/状态事件，由 SSE 转发给前端。
// 轻量组件，无持久化；生成任务都是短生命周期，无需落库。
export interface GenEvent {
  type: 'log' | 'storyboard' | 'merge' | 'done' | 'error';
  // log: { level:'info'|'success'|'warn'|'error', text, at }
  // storyboard: { id, status, progress }
  // merge: { progress }
  data: any;
}

@Injectable()
export class LogBusService {
  private episodes = new Map<number, Subject<GenEvent>>();

  subscribe(episodeId: number): Observable<string> {
    const subject = this.getSubject(episodeId);
    return subject.asObservable().pipe(map((e) => JSON.stringify(e)));
  }

  emit(episodeId: number, event: GenEvent) {
    const subject = this.episodes.get(episodeId);
    if (subject) subject.next(event);
  }

  private getSubject(episodeId: number): Subject<GenEvent> {
    let subject = this.episodes.get(episodeId);
    if (!subject) {
      subject = new Subject<GenEvent>();
      this.episodes.set(episodeId, subject);
    }
    return subject;
  }
}