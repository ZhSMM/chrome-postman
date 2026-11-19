import { describe, expect, it } from 'vitest';
import {
  emptyScope,
  interpolate,
  interpolateText,
  keyValuesToRecord,
  lookupVariable,
  mergeScopes,
} from '../src/core/variables';

describe('变量引擎', () => {
  const scope = {
    environment: { host: 'api.dev.com', token: 'env-token' },
    collection: { version: 'v1', token: 'collection-token' },
    globals: { gkey: 'gvalue' },
    session: { skey: 'svalue' },
  };

  it('能替换单个变量', () => {
    expect(interpolateText('https://{{host}}/api', scope)).toBe('https://api.dev.com/api');
  });

  it('能替换多个变量与占位符中的空格', () => {
    expect(interpolateText('{{ host }}/{{ version }}/{{ gkey }}', scope)).toBe('api.dev.com/v1/gvalue');
  });

  it('环境变量优先级高于集合变量', () => {
    expect(lookupVariable('token', scope)).toBe('env-token');
  });

  it('找不到的变量保持原样并被记录', () => {
    const result = interpolate('{{notExist}}/x', scope);
    expect(result.text).toBe('{{notExist}}/x');
    expect(result.missing).toEqual(['notExist']);
  });

  it('内置动态变量可求值', () => {
    const result = interpolate('{{$timestamp}}', scope);
    expect(result.missing).toEqual([]);
    expect(Number(result.text)).toBeGreaterThan(1_600_000_000);
  });

  it('$uuid 每次生成不同的值', () => {
    const a = interpolateText('{{$uuid}}', scope);
    const b = interpolateText('{{$uuid}}', scope);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keyValuesToRecord 跳过未启用与空键的行', () => {
    const record = keyValuesToRecord([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: false },
      { key: '', value: '3', enabled: true },
      { key: 'c', value: '4', enabled: true },
    ]);
    expect(record).toEqual({ a: '1', c: '4' });
  });

  it('mergeScopes 用补丁覆盖原值', () => {
    const merged = mergeScopes(scope, { environment: { token: 'new-token' } });
    expect(merged.environment.token).toBe('new-token');
    expect(merged.environment.host).toBe('api.dev.com');
    expect(merged.globals.gkey).toBe('gvalue');
  });

  it('空作用域不会抛错', () => {
    expect(interpolate('{{x}}', emptyScope()).text).toBe('{{x}}');
  });
});
