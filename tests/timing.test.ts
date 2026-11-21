/**
 * 耗时分段（timing）的单元测试。
 *
 * 【为什么这些测试重要】
 * 耗时面板的数字如果算错，用户会误判"到底是网络慢还是服务端慢"，
 * 反而比不显示更糟。而且时间戳的边界情况（缺事件、乱序）很容易出错。
 */
import { describe, expect, it } from 'vitest';
import { buildTiming, TimingBuffer, type TimingEvent } from '../src/core/timing';

/** 造一条事件 */
function ev(
  phase: TimingEvent['phase'],
  timeStamp: number,
  extra: Partial<TimingEvent> = {},
): TimingEvent {
  return {
    requestId: 'r1',
    url: 'https://api.example.com/users',
    method: 'GET',
    phase,
    timeStamp,
    ...extra,
  };
}

describe('buildTiming —— 计算分段耗时', () => {
  it('用四个事件算出三段耗时', () => {
    const timing = buildTiming([
      ev('beforeRequest', 1000),
      ev('sendHeaders', 1045),
      ev('responseStarted', 1865),
      ev('completed', 1877),
    ]);
    expect(timing.phases.connect).toBe(45);
    expect(timing.phases.waiting).toBe(820);
    expect(timing.phases.download).toBe(12);
    expect(timing.total).toBe(877);
    expect(timing.source).toBe('webRequest');
  });

  it('事件顺序打乱也能正确计算（按阶段查找，不依赖顺序）', () => {
    const timing = buildTiming([
      ev('completed', 1877),
      ev('responseStarted', 1865),
      ev('beforeRequest', 1000),
      ev('sendHeaders', 1045),
    ]);
    expect(timing.phases.connect).toBe(45);
    expect(timing.phases.waiting).toBe(820);
    expect(timing.phases.download).toBe(12);
  });

  it('缺少关键时间戳时退回本地总耗时', () => {
    const timing = buildTiming([ev('beforeRequest', 1000)], 999);
    expect(timing.source).toBe('local');
    expect(timing.total).toBe(999);
    expect(timing.phases.connect).toBe(0);
  });

  it('完全没有任何事件时也退回本地总耗时', () => {
    const timing = buildTiming([], 500);
    expect(timing.source).toBe('local');
    expect(timing.total).toBe(500);
  });

  it('缺少中间阶段时该段记为 0，其余照常', () => {
    // 没有 onSendHeaders → connect 段算不出来
    const timing = buildTiming([ev('beforeRequest', 1000), ev('completed', 1500)]);
    expect(timing.source).toBe('webRequest');
    expect(timing.phases.connect).toBe(0);
    expect(timing.phases.waiting).toBe(0);
    expect(timing.phases.download).toBe(0);
    expect(timing.total).toBe(500);
  });

  it('不会出现负数耗时', () => {
    // 时间戳异常（后面的比前面的早）时不能算出负值
    const timing = buildTiming([
      ev('beforeRequest', 2000),
      ev('sendHeaders', 1000),
      ev('responseStarted', 3000),
      ev('completed', 2500),
    ]);
    expect(timing.phases.connect).toBeGreaterThanOrEqual(0);
    expect(timing.phases.waiting).toBeGreaterThanOrEqual(0);
    expect(timing.phases.download).toBeGreaterThanOrEqual(0);
  });

  it('带出服务器 IP 和缓存标记', () => {
    const timing = buildTiming(
      [ev('beforeRequest', 1000), ev('completed', 1500, { ip: '203.0.113.9', fromCache: true })],
      500,
    );
    expect(timing.serverIp).toBe('203.0.113.9');
    expect(timing.fromCache).toBe(true);
  });
});

describe('TimingBuffer —— 采集缓冲区', () => {
  it('按 requestId 归集同一请求的事件', () => {
    const buffer = new TimingBuffer();
    buffer.add(ev('beforeRequest', 1000));
    buffer.add(ev('sendHeaders', 1040, { requestId: 'r1' }));
    buffer.add(ev('responseStarted', 1500, { requestId: 'r1' }));
    buffer.add(ev('completed', 1520, { requestId: 'r1' }));

    const timing = buffer.find('https://api.example.com/users');
    expect(timing?.phases.connect).toBe(40);
    expect(timing?.total).toBe(520);
  });

  it('同一阶段重复触发只保留最早的一个', () => {
    const buffer = new TimingBuffer();
    buffer.add(ev('beforeRequest', 1000));
    buffer.add(ev('beforeRequest', 900)); // 理论上不会更早，但要有防护
    const events = buffer.getEvents('r1');
    expect(events.filter((e) => e.phase === 'beforeRequest')).toHaveLength(1);
  });

  it('查不到时返回 null', () => {
    const buffer = new TimingBuffer();
    expect(buffer.find('https://never-seen.example.com/')).toBeNull();
  });

  it('同一个 URL 后一次请求会覆盖前一次', () => {
    const buffer = new TimingBuffer();
    buffer.add(ev('beforeRequest', 1000, { requestId: 'r1' }));
    buffer.add(ev('completed', 1200, { requestId: 'r1' }));
    buffer.add(ev('beforeRequest', 2000, { requestId: 'r2' }));
    buffer.add(ev('completed', 2600, { requestId: 'r2' }));

    const timing = buffer.find('https://api.example.com/users');
    expect(timing?.total).toBe(600);
  });

  it('不同 URL 互不干扰', () => {
    const buffer = new TimingBuffer();
    buffer.add(ev('beforeRequest', 1000, { requestId: 'r1', url: 'https://a.test/' }));
    buffer.add(ev('completed', 1200, { requestId: 'r1', url: 'https://a.test/' }));
    buffer.add(ev('beforeRequest', 2000, { requestId: 'r2', url: 'https://b.test/' }));
    buffer.add(ev('completed', 2600, { requestId: 'r2', url: 'https://b.test/' }));

    expect(buffer.find('https://a.test/')?.total).toBe(200);
    expect(buffer.find('https://b.test/')?.total).toBe(600);
  });

  it('prune 之后只保留最近的记录', () => {
    const buffer = new TimingBuffer();
    for (let i = 0; i < 10; i += 1) {
      buffer.add(ev('beforeRequest', 1000 + i, { requestId: `r${i}` }));
    }
    expect(buffer.size).toBe(10);
    buffer.prune(5);
    expect(buffer.size).toBe(5);
    // 最近的那个还在
    expect(buffer.getEvents('r9')).toHaveLength(1);
  });
});
