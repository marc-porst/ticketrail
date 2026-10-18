import type { ServerResponse } from 'node:http';
import type { BoardEvent } from '../core/watch.ts';

/** Subscribers are grouped by project: a write in one board must not wake another. */
export class SseHub {
  private clients = new Map<string, Set<ServerResponse>>();
  private heartbeat: NodeJS.Timeout | null = null;

  attach(projectId: string, res: ServerResponse, snapshot: unknown): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    this.send(res, 'snapshot', snapshot);
    const group = this.clients.get(projectId) ?? new Set<ServerResponse>();
    group.add(res);
    this.clients.set(projectId, group);
    res.on('close', () => {
      group.delete(res);
      if (!group.size) this.clients.delete(projectId);
    });

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const group of this.clients.values()) {
          for (const client of group) client.write(': ping\n\n');
        }
      }, 25_000);
      this.heartbeat.unref?.();
    }
  }

  broadcast(projectId: string, event: BoardEvent): void {
    for (const client of this.clients.get(projectId) ?? []) this.send(client, 'board', event);
  }

  /** Worker presence changed: a worker started or stopped waiting, or checked in. */
  broadcastWorkers(projectId: string, presence: unknown): void {
    for (const client of this.clients.get(projectId) ?? []) this.send(client, 'workers', presence);
  }

  /** Whether anyone is watching this project, so watchers start only when needed. */
  watching(projectId: string): boolean {
    return (this.clients.get(projectId)?.size ?? 0) > 0;
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  get size(): number {
    let total = 0;
    for (const group of this.clients.values()) total += group.size;
    return total;
  }
}
