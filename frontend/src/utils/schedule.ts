/**
 * 排产台账纯工具：机型日锅次上限、可用余量、锅次顺延查找。
 * 不依赖 Dexie，便于在 db 事务与页面选择器之间复用同一套算法。
 */
import type { GreenBean } from '../types/greenbean';
import {
  DEFAULT_DAILY_POT_LIMIT,
  DEFAULT_OPERATOR_NAME,
  MAX_SCHEDULE_LOOKAHEAD_DAYS,
  OPERATOR_NAME_STORAGE_KEY,
  type MachineCapacity,
  type SchedulePot,
} from '../types/schedule';

/** 读取本地保存的排产人称呼 */
export function loadOperatorName(): string {
  try {
    return localStorage.getItem(OPERATOR_NAME_STORAGE_KEY)?.trim() || DEFAULT_OPERATOR_NAME;
  } catch {
    return DEFAULT_OPERATOR_NAME;
  }
}

/** 保存排产人称呼到本地 */
export function saveOperatorName(name: string): void {
  try {
    localStorage.setItem(OPERATOR_NAME_STORAGE_KEY, name.trim() || DEFAULT_OPERATOR_NAME);
  } catch {
    /* 隐私模式等场景忽略写入失败 */
  }
}

/** 某机型的日锅次上限（未配置时用默认值，夹在 1-99） */
export function potLimitFor(model: string, capacities: MachineCapacity[]): number {
  const found = capacities.find((item) => item.model === model);
  const raw = found?.dailyPotLimit ?? DEFAULT_DAILY_POT_LIMIT;
  if (!Number.isFinite(raw)) return DEFAULT_DAILY_POT_LIMIT;
  return Math.min(99, Math.max(1, Math.round(raw)));
}

/** 把 YYYY-MM-DD 字符串加 days 天，返回新的 YYYY-MM-DD */
export function addDays(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 某机型某天已占用（非作废）的锅次序号集合 */
export function occupiedPotSet(pots: SchedulePot[], model: string, date: string): Set<number> {
  const set = new Set<number>();
  pots.forEach((pot) => {
    if (pot.machineModel === model && pot.scheduledDate === date && pot.state !== 'void') {
      set.add(pot.potIndex);
    }
  });
  return set;
}

export interface SlotRef {
  date: string;
  potIndex: number;
}

/**
 * 从请求日起找该机型最早的空锅次：
 * 当天 1..limit 锅依次找空，排满则顺延到次日（最多向后找 MAX_SCHEDULE_LOOKAHEAD_DAYS）。
 */
export function findEarliestSlot(
  pots: SchedulePot[],
  model: string,
  requestedDate: string,
  limit: number,
): SlotRef | null {
  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_DAYS; offset += 1) {
    const date = addDays(requestedDate, offset);
    const occupied = occupiedPotSet(pots, model, date);
    for (let potIndex = 1; potIndex <= limit; potIndex += 1) {
      if (!occupied.has(potIndex)) return { date, potIndex };
    }
  }
  return null;
}

/** 某生豆被其它锅次预留中的克重（kg）；excludeProfileId 用于编辑时排除自身 */
export function reservedKgOfBean(
  beanId: string,
  pots: SchedulePot[],
  excludeProfileId?: string,
): number {
  const grams = pots
    .filter(
      (pot) =>
        pot.greenBeanId === beanId &&
        pot.state === 'reserved' &&
        pot.profileId !== excludeProfileId,
    )
    .reduce((acc, pot) => acc + pot.chargeG, 0);
  return Math.round(grams) / 1000;
}

/**
 * 生豆可用余量（kg）= 在库重量 − 预留中克重。
 * 已扣减（consumed）的锅次已在 stockKg 里扣过，不再重复减；作废锅次已释放。
 */
export function availableKgOfBean(
  bean: GreenBean | undefined,
  pots: SchedulePot[],
  excludeProfileId?: string,
): number {
  if (!bean) return 0;
  const available = bean.stockKg - reservedKgOfBean(bean.id, pots, excludeProfileId);
  return Math.round(available * 1000) / 1000;
}

/** 锅次是否相对请求日发生了顺延 */
export function isRolledOver(requestedDate: string, scheduledDate: string): boolean {
  return scheduledDate > requestedDate;
}
