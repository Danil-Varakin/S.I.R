// [DRIFT] upstream добавил Urgent в enum и строку в stop — правка в цикле start ложится как прежде
import type { Logger } from './logger.ts';

export enum Priority {
  Low = 0,
  Normal = 10,
  High = 20,
  Urgent = 30,
}

export interface Task<T> {
  id: string;
  payload: T;
  priority: Priority;
}

export interface Queue<T> {
  push(task: Task<T>): void;
  pop(): Task<T> | undefined;
  size(): number;
}

type Handler<T> = (task: Task<T>) => Promise<void>;

export function schedule<T>(queue: Queue<T>, task: Task<T>): void;
export function schedule<T>(queue: Queue<T>, tasks: readonly Task<T>[]): void;
export function schedule<T>(queue: Queue<T>, input: Task<T> | readonly Task<T>[]): void {
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    queue.push(item);
  }
}

export class Worker<T> {
  private running = false;

  constructor(
    private readonly queue: Queue<T>,
    private readonly handler: Handler<T>,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const task = this.queue.pop();
      if (task === undefined) {
        this.log.info('queue drained');
        break;
      }
      await this.handler(task);
    }
  }

  stop(): void {
    this.running = false;
    this.log.info('stopped');
  }
}

export namespace metrics {
  export interface Snapshot {
    pending: number;
    done: number;
  }

  export function empty(): Snapshot {
    return { pending: 0, done: 0 };
  }
}
