import { Redis } from "ioredis";

export interface QueueMessage {
  job_id: string;
  outbox_id: number;
}

/**
 * Redis 只负责把已提交的 outbox 提醒给 worker。
 * 队列里出现消息、消息被消费，都不表示任务已完成。完成只看 MySQL 里的终态。
 * 投递是至少一次。重复消息必须靠 MySQL 租约和围栏消掉，不能靠队列去重保证副作用只发生一次。
 */
export class RedisJobQueue {
  private readonly redis: Redis;

  constructor(
    private readonly options: { host: string; port: number; password: string; queueKey: string },
  ) {
    if (options.host !== "127.0.0.1") throw new Error("Redis 只接受 127.0.0.1 上的隔离实例");
    this.redis = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableReadyCheck: true,
    });
  }

  async connect(): Promise<void> {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  async publish(message: QueueMessage): Promise<void> {
    await this.connect();
    await this.redis.lpush(this.options.queueKey, JSON.stringify({ job_id: message.job_id, outbox_id: message.outbox_id }));
  }

  async take(timeoutSeconds: number): Promise<QueueMessage | null> {
    await this.connect();
    const result = await this.redis.brpop(this.options.queueKey, timeoutSeconds);
    if (!result) return null;
    const parsed = JSON.parse(result[1]) as Partial<QueueMessage>;
    if (!parsed.job_id) return null;
    return { job_id: String(parsed.job_id), outbox_id: Number(parsed.outbox_id ?? 0) };
  }

  async depth(): Promise<number> {
    await this.connect();
    return this.redis.llen(this.options.queueKey);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
