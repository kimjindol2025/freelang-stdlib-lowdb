/**
 * FreeLang v2 stdlib — stdlib-lowdb.ts
 *
 * npm lowdb 완전 대체 네이티브 구현
 * Node.js 내장 fs / path 모듈만 사용 (외부 npm 0개)
 *
 * 등록 함수:
 *   lowdb_create(filePath, defaultJson)          → string (dbId)
 *   lowdb_get(dbId, path)                        → any
 *   lowdb_set(dbId, path, valueJson)             → void
 *   lowdb_push(dbId, path, valueJson)            → void
 *   lowdb_remove(dbId, path)                     → void
 *   lowdb_has(dbId, path)                        → bool
 *   lowdb_write(dbId)                            → void
 *   lowdb_read(dbId)                             → void
 *   lowdb_keys(dbId, path)                       → string[]
 *   lowdb_size(dbId, path)                       → int
 *   lowdb_find(dbId, path, key, valueJson)       → any
 *   lowdb_filter(dbId, path, key, valueJson)     → any[]
 *   lowdb_update(dbId, path, key, keyJson, patchJson) → void
 *
 * path 문법:
 *   ""             → 루트 전체
 *   "users"        → 최상위 키
 *   "users.0"      → 배열 인덱스 0
 *   "users.0.name" → 중첩 경로
 *   "a.b.c"        → 임의 깊이 중첩
 */

import { NativeFunctionRegistry } from './vm/native-function-registry';
import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// 내부 DB 레지스트리
// ─────────────────────────────────────────────────────────────────────────────

interface DBEntry {
  filePath: string;
  data: Record<string, any>;
}

const dbRegistry = new Map<string, DBEntry>();

// ─────────────────────────────────────────────────────────────────────────────
// path 파싱 유틸
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "users.0.name" → ["users", "0", "name"]
 * ""             → []
 */
function parsePath(dotPath: string): string[] {
  if (!dotPath || !dotPath.trim()) return [];
  return dotPath.split('.').filter(Boolean);
}

/**
 * 중첩 객체에서 경로 값 읽기
 * 없으면 undefined 반환
 */
function getByPath(obj: any, segments: string[]): any {
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(seg, 10);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = current[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 중첩 객체에 경로 값 쓰기 (immutable — 새 객체 반환)
 * 중간 경로가 없으면 자동 생성
 */
function setByPath(obj: any, segments: string[], value: any): any {
  if (segments.length === 0) return value;

  const [head, ...tail] = segments;
  const isArrayIdx = /^\d+$/.test(head);

  if (isArrayIdx) {
    const idx  = parseInt(head, 10);
    const copy = Array.isArray(obj) ? [...obj] : [];
    copy[idx]  = tail.length === 0 ? value : setByPath(copy[idx] ?? {}, tail, value);
    return copy;
  }

  const copy: Record<string, any> = (obj && typeof obj === 'object' && !Array.isArray(obj))
    ? { ...obj }
    : {};
  copy[head] = tail.length === 0 ? value : setByPath(copy[head] ?? {}, tail, value);
  return copy;
}

/**
 * 중첩 객체에서 경로 값 삭제 (immutable)
 */
function removeByPath(obj: any, segments: string[]): any {
  if (segments.length === 0) return undefined;

  const [head, ...tail] = segments;
  const isArrayIdx = /^\d+$/.test(head);

  if (isArrayIdx && Array.isArray(obj)) {
    const idx  = parseInt(head, 10);
    const copy = [...obj];
    if (tail.length === 0) {
      copy.splice(idx, 1);
    } else {
      copy[idx] = removeByPath(copy[idx], tail);
    }
    return copy;
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const copy: Record<string, any> = { ...obj };
    if (tail.length === 0) {
      delete copy[head];
    } else {
      copy[head] = removeByPath(copy[head], tail);
    }
    return copy;
  }

  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// 파일 I/O
// ─────────────────────────────────────────────────────────────────────────────

function loadFile(filePath: string, defaultData: Record<string, any>): Record<string, any> {
  try {
    if (!fs.existsSync(filePath)) return { ...defaultData };
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return { ...defaultData };
    return JSON.parse(raw);
  } catch {
    return { ...defaultData };
  }
}

function saveFile(filePath: string, data: Record<string, any>): void {
  try {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e: any) {
    throw new Error(`lowdb write 실패: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// any → FreeLang 호환 변환
// ─────────────────────────────────────────────────────────────────────────────

function toFreeLang(val: any): any {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map(toFreeLang);
  if (typeof val === 'object') {
    const m = new Map<string, any>();
    for (const [k, v] of Object.entries(val)) m.set(k, toFreeLang(v));
    return m;
  }
  return val;
}

/** FreeLang Map → plain object (재귀) */
function fromFreeLang(val: any): any {
  if (val instanceof Map) {
    const obj: Record<string, any> = {};
    (val as Map<string, any>).forEach((v, k) => { obj[k] = fromFreeLang(v); });
    return obj;
  }
  if (Array.isArray(val)) return val.map(fromFreeLang);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// registerLowdbFunctions — 메인 등록 함수
// ─────────────────────────────────────────────────────────────────────────────

export function registerLowdbFunctions(registry: NativeFunctionRegistry): void {

  // ── lowdb_create ──────────────────────────────────────────────────────────
  // lowdb_create(filePath, defaultJson) → string (dbId)
  registry.register({
    name: 'lowdb_create',
    module: 'lowdb',
    executor: (args) => {
      const filePath    = String(args[0] ?? 'db.json');
      const defaultJson = String(args[1] ?? '{}');

      let defaultData: Record<string, any> = {};
      try { defaultData = JSON.parse(defaultJson); } catch {}

      const data = loadFile(filePath, defaultData);

      // 파일이 없으면 기본 데이터로 즉시 생성
      if (!fs.existsSync(filePath)) {
        saveFile(filePath, data);
      }

      const id = `lowdb_${crypto.randomBytes(6).toString('hex')}`;
      dbRegistry.set(id, { filePath, data });
      return id;
    }
  });

  // ── lowdb_get ─────────────────────────────────────────────────────────────
  // lowdb_get(dbId, path) → any
  registry.register({
    name: 'lowdb_get',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;
      const segments = parsePath(String(args[1] ?? ''));
      const val = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      return toFreeLang(val ?? null);
    }
  });

  // ── lowdb_set ─────────────────────────────────────────────────────────────
  // lowdb_set(dbId, path, valueJson) → void
  registry.register({
    name: 'lowdb_set',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;

      const segments  = parsePath(String(args[1] ?? ''));
      let value: any  = null;
      try { value = JSON.parse(String(args[2] ?? 'null')); } catch {}

      if (segments.length === 0) {
        entry.data = value ?? {};
      } else {
        entry.data = setByPath(entry.data, segments, value);
      }
      return null;
    }
  });

  // ── lowdb_push ────────────────────────────────────────────────────────────
  // lowdb_push(dbId, path, valueJson) → void
  // 대상 경로가 배열이어야 함, 없으면 배열 생성
  registry.register({
    name: 'lowdb_push',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;

      const segments = parsePath(String(args[1] ?? ''));
      let value: any = null;
      try { value = JSON.parse(String(args[2] ?? 'null')); } catch {}
      value = fromFreeLang(value);

      const current = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      const arr     = Array.isArray(current) ? [...current, value] : [value];

      if (segments.length === 0) {
        entry.data = arr as any;
      } else {
        entry.data = setByPath(entry.data, segments, arr);
      }
      return null;
    }
  });

  // ── lowdb_remove ──────────────────────────────────────────────────────────
  // lowdb_remove(dbId, path) → void
  registry.register({
    name: 'lowdb_remove',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;

      const segments = parsePath(String(args[1] ?? ''));
      if (segments.length === 0) {
        entry.data = {};
      } else {
        entry.data = removeByPath(entry.data, segments) ?? {};
      }
      return null;
    }
  });

  // ── lowdb_has ─────────────────────────────────────────────────────────────
  // lowdb_has(dbId, path) → bool
  registry.register({
    name: 'lowdb_has',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return false;
      const segments = parsePath(String(args[1] ?? ''));
      if (segments.length === 0) return true;
      return getByPath(entry.data, segments) !== undefined;
    }
  });

  // ── lowdb_write ───────────────────────────────────────────────────────────
  // lowdb_write(dbId) → void
  registry.register({
    name: 'lowdb_write',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;
      saveFile(entry.filePath, entry.data);
      return null;
    }
  });

  // ── lowdb_read ────────────────────────────────────────────────────────────
  // lowdb_read(dbId) → void
  registry.register({
    name: 'lowdb_read',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;
      entry.data = loadFile(entry.filePath, {});
      return null;
    }
  });

  // ── lowdb_keys ────────────────────────────────────────────────────────────
  // lowdb_keys(dbId, path) → string[]
  registry.register({
    name: 'lowdb_keys',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return [];
      const segments = parsePath(String(args[1] ?? ''));
      const target   = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      if (target === null || target === undefined) return [];
      if (Array.isArray(target)) return target.map((_: any, i: number) => String(i));
      if (typeof target === 'object') return Object.keys(target);
      return [];
    }
  });

  // ── lowdb_size ────────────────────────────────────────────────────────────
  // lowdb_size(dbId, path) → int
  registry.register({
    name: 'lowdb_size',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return 0;
      const segments = parsePath(String(args[1] ?? ''));
      const target   = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      if (target === null || target === undefined) return 0;
      if (Array.isArray(target)) return target.length;
      if (typeof target === 'object') return Object.keys(target).length;
      if (typeof target === 'string') return target.length;
      return 0;
    }
  });

  // ── lowdb_find ────────────────────────────────────────────────────────────
  // lowdb_find(dbId, path, key, valueJson) → any
  // 배열 내에서 item[key] === value 인 첫 항목 반환
  registry.register({
    name: 'lowdb_find',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;

      const segments = parsePath(String(args[1] ?? ''));
      const key      = String(args[2] ?? '');
      let   target_val: any = null;
      try { target_val = JSON.parse(String(args[3] ?? 'null')); } catch {}

      const arr = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      if (!Array.isArray(arr)) return null;

      const found = arr.find((item: any) => {
        if (item === null || typeof item !== 'object') return false;
        // key에 중첩 경로 지원 ("user.id")
        const itemVal = getByPath(item, parsePath(key));
        return JSON.stringify(itemVal) === JSON.stringify(target_val);
      });
      return found !== undefined ? toFreeLang(found) : null;
    }
  });

  // ── lowdb_filter ──────────────────────────────────────────────────────────
  // lowdb_filter(dbId, path, key, valueJson) → any[]
  registry.register({
    name: 'lowdb_filter',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return [];

      const segments = parsePath(String(args[1] ?? ''));
      const key      = String(args[2] ?? '');
      let   target_val: any = null;
      try { target_val = JSON.parse(String(args[3] ?? 'null')); } catch {}

      const arr = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      if (!Array.isArray(arr)) return [];

      return arr
        .filter((item: any) => {
          if (item === null || typeof item !== 'object') return false;
          const itemVal = getByPath(item, parsePath(key));
          return JSON.stringify(itemVal) === JSON.stringify(target_val);
        })
        .map(toFreeLang);
    }
  });

  // ── lowdb_update ──────────────────────────────────────────────────────────
  // lowdb_update(dbId, path, key, keyJson, patchJson) → void
  // item[key] === keyValue 인 항목을 patch로 병합 업데이트
  registry.register({
    name: 'lowdb_update',
    module: 'lowdb',
    executor: (args) => {
      const entry = dbRegistry.get(String(args[0] ?? ''));
      if (!entry) return null;

      const segments = parsePath(String(args[1] ?? ''));
      const key      = String(args[2] ?? '');
      let   keyVal: any   = null;
      let   patch: any    = {};
      try { keyVal = JSON.parse(String(args[3] ?? 'null')); } catch {}
      try { patch  = JSON.parse(String(args[4] ?? '{}')); } catch {}
      patch = fromFreeLang(patch);

      const arr = segments.length === 0 ? entry.data : getByPath(entry.data, segments);
      if (!Array.isArray(arr)) return null;

      const keySegs = parsePath(key);
      const updated = arr.map((item: any) => {
        if (item === null || typeof item !== 'object') return item;
        const itemVal = getByPath(item, keySegs);
        if (JSON.stringify(itemVal) !== JSON.stringify(keyVal)) return item;
        return { ...item, ...patch };
      });

      if (segments.length === 0) {
        entry.data = updated as any;
      } else {
        entry.data = setByPath(entry.data, segments, updated);
      }
      return null;
    }
  });
}
