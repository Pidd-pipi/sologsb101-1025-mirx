/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbroastlog，数据结构版本号 DB_VERSION = 2（version(1) 初版 + version(2) 真实迁移）
 * - 生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案 分表存储（另有载量模板表）
 * - 首屏自动播种演示数据（父→子→孙三层贯通，幂等）
 * - 整库快照导出导入、级联删除、下豆扣减生豆在库重量
 * 纯前端应用：不依赖任何后端或数据库服务。
 */
import Dexie, { type Table } from 'dexie';
import type { GreenBean } from '../types/greenbean';
import { LOW_STOCK_KG } from '../types/greenbean';
import type { MachineTemplate, RoastProfile, RoastState } from '../types/roastprofile';
import { ROAST_STATE_LABEL } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { weightedTotalScore } from '../types/cupping';
import type { Blend } from '../types/blend';
import type { BatchBooking, RoasterMachine } from '../types/schedule';
import { BOOKING_STATE_LABEL, makeSlotKey } from '../types/schedule';
import { addDaysLocal, availableKg, gToKg, isDayFull, todayLocal } from './schedule';
import { rorPerMinBetween } from './curve';

/** 数据库名（= 项目英文短名） */
export const DB_NAME = 'gbroastlog';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

/**
 * 时段被占用的冲突：晚到的一单据此看到「被谁占了」。
 * 唯一索引兜底保证跨标签页（两人同时提交）也只成功一单。
 */
export class SlotConflictError extends Error {
  occupant: BatchBooking;
  constructor(occupant: BatchBooking) {
    super(
      `该时段已被 ${occupant.operator} 的 ${occupant.chargeG}g 锅次（${occupant.planDate} ${occupant.slotAt}）占用`,
    );
    this.name = 'SlotConflictError';
    this.occupant = occupant;
  }
}

/** 排产账本规则冲突（锅次上限、余量不足等） */
export class ScheduleRuleError extends Error {}

class RoastLogDatabase extends Dexie {
  greenBeans!: Table<GreenBean, string>;
  roastProfiles!: Table<RoastProfile, string>;
  events!: Table<RoastEvent, string>;
  cuppings!: Table<Cupping, string>;
  blends!: Table<Blend, string>;
  machineTemplates!: Table<MachineTemplate, string>;
  roasterMachines!: Table<RoasterMachine, string>;
  batchBookings!: Table<BatchBooking, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅业务字段，保留历史数据）
    this.version(1).stores({
      greenBeans: 'id, origin, process, arrivedAt, createdAt',
      roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state',
      events: 'id, profileId, type, atSec',
      cuppings: 'id, profileId, cuppedAt',
      blends: 'id, name, state, createdAt',
    });

    // v2：补齐 createdAt/updatedAt 索引；新增载量模板表；按时间顺序补算历史 RoR 与杯测总分
    this.version(DB_VERSION)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 全部表补齐 createdAt / updatedAt（v1 只写了业务字段）
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('greenBeans'),
          tx.table('roastProfiles'),
          tx.table('events'),
          tx.table('cuppings'),
          tx.table('blends'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.createdAt !== 'string' || row.createdAt === '') row.createdAt = stamp;
            if (typeof row.updatedAt !== 'string' || row.updatedAt === '') row.updatedAt = row.createdAt;
          });
        }

        // 2) 生豆：兜底处理法、含水率与在库重量
        await tx.table('greenBeans').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.process !== 'string') row.process = 'washed';
          if (typeof row.moisturePct !== 'number') row.moisturePct = 11;
          if (typeof row.stockKg !== 'number' || !Number.isFinite(row.stockKg)) row.stockKg = 0;
        });

        // 3) 烘焙记录：兜底状态、风门与火力档
        await tx.table('roastProfiles').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string') row.state = 'recording';
          if (typeof row.airflow !== 'string') row.airflow = 'half';
          if (typeof row.gasLevel !== 'number') row.gasLevel = 3;
        });

        // 4) 曲线事件：按 profileId 分组、按时间升序补算缺失的 RoR，并补齐备注
        const eventRows = (await tx.table('events').toArray()) as Array<Record<string, unknown>>;
        const grouped = new Map<string, Array<Record<string, unknown>>>();
        eventRows.forEach((row) => {
          const profileId = typeof row.profileId === 'string' ? row.profileId : '';
          const list = grouped.get(profileId) ?? [];
          list.push(row);
          grouped.set(profileId, list);
        });
        const migratedEvents: Array<Record<string, unknown>> = [];
        grouped.forEach((list) => {
          list.sort((a, b) => Number(a.atSec ?? 0) - Number(b.atSec ?? 0));
          list.forEach((row, index) => {
            const prev = list[index - 1];
            if ((typeof row.rorPerMin !== 'number' || row.rorPerMin === 0) && prev) {
              row.rorPerMin = rorPerMinBetween(
                Number(prev.atSec ?? 0),
                Number(prev.beanTempC ?? 0),
                Number(row.atSec ?? 0),
                Number(row.beanTempC ?? 0),
              );
            }
            if (typeof row.rorPerMin !== 'number') row.rorPerMin = 0;
            if (typeof row.note !== 'string') row.note = '';
            migratedEvents.push(row);
          });
        });
        if (migratedEvents.length > 0) {
          await tx.table('events').bulkPut(migratedEvents);
        }

        // 5) 杯测：按分项加权补算历史总分
        await tx.table('cuppings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.totalScore !== 'number' || row.totalScore <= 0) {
            row.totalScore = weightedTotalScore({
              dryAroma: Number(row.dryAroma ?? 0),
              wetAroma: Number(row.wetAroma ?? 0),
              acidity: Number(row.acidity ?? 0),
              sweetness: Number(row.sweetness ?? 0),
              aftertaste: Number(row.aftertaste ?? 0),
            });
          }
        });

        // 6) 拼配方案：兜底配方明细与状态
        await tx.table('blends').toCollection().modify((row: Record<string, unknown>) => {
          if (!Array.isArray(row.items)) row.items = [];
          if (typeof row.state !== 'string') row.state = 'trial';
          if (typeof row.targetFlavor !== 'string') row.targetFlavor = '';
        });
      });

    // v3：排产账本——新增烘焙机（当天锅次上限）与锅次占用单两表；
    // slotKey 唯一索引保证同机同日同时段只成功一单（跨标签页并发同样成立）。
    this.version(DB_VERSION)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
        roasterMachines: 'id, model, enabled, createdAt',
        batchBookings: 'id, machineId, greenBeanId, profileId, planDate, state, slotKey, updatedAt',
      })
      .upgrade(async (tx) => {
        // 老库升级：按已有烘焙记录出现过的机型 + 常见机型补登记烘焙机，当天锅次上限给默认值。
        const machineTable = tx.table<RoasterMachine, string>('roasterMachines');
        if ((await machineTable.count()) === 0) {
          const stamp = nowIso();
          const profileRows = await tx.table<RoastProfile, string>('roastProfiles').toArray();
          const usedModels = Array.from(new Set(profileRows.map((profile) => profile.machineModel).filter(Boolean)));
          const defaults: Array<[string, number]> = [
            ['HB-M6', 6],
            ['Giesen W6A', 8],
            ['Probat P12', 4],
            ['Mill City 500g', 10],
          ];
          const defaultMap = new Map(defaults);
          const models = Array.from(new Set([...usedModels, ...defaults.map(([model]) => model)]));
          await machineTable.bulkPut(
            models.map((model, index) => ({
              id: `rm-seed-${index}`,
              model,
              dailyLimit: defaultMap.get(model) ?? 8,
              slotMinutes: 30,
              openFrom: '08:30',
              openTo: '18:00',
              note: usedModels.includes(model) ? '按历史烘焙记录补登记' : '默认机型，可编辑上限',
              enabled: true,
              createdAt: stamp,
              updatedAt: stamp,
            })),
          );
        }
      });
  }
}

export const db = new RoastLogDatabase();

/* ------------------------------ 通用工具 ------------------------------ */

/** 生成带前缀的主键 id */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 保留三位小数的重量换算 */
export function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* --------------------------- 生豆 GreenBean --------------------------- */

export async function listGreenBeans(): Promise<GreenBean[]> {
  const rows = await db.greenBeans.toArray();
  return rows.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt) || a.origin.localeCompare(b.origin, 'zh-Hans-CN'));
}

export async function getGreenBean(id: string): Promise<GreenBean | undefined> {
  return db.greenBeans.get(id);
}

export async function putGreenBean(row: GreenBean): Promise<void> {
  await db.greenBeans.put(row);
}

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测、排产锅次，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.batchBookings],
    async () => {
      const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
      const profileIds = profiles.map((profile) => profile.id);
      if (profileIds.length > 0) {
        await db.events.where('profileId').anyOf(profileIds).delete();
        await db.cuppings.where('profileId').anyOf(profileIds).delete();
        await db.batchBookings.where('profileId').anyOf(profileIds).delete();
        await db.roastProfiles.bulkDelete(profileIds);
      }
      await db.batchBookings.where('greenBeanId').equals(id).delete();
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.greenBeanId !== id && !profileIds.includes(item.profileId));
        return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.greenBeans.delete(id);
  });
}

/* ------------------------ 烘焙记录 RoastProfile ------------------------ */

export async function listRoastProfiles(): Promise<RoastProfile[]> {
  const rows = await db.roastProfiles.toArray();
  return rows.sort((a, b) => b.roastedAt.localeCompare(a.roastedAt));
}

export async function getRoastProfile(id: string): Promise<RoastProfile | undefined> {
  return db.roastProfiles.get(id);
}

export async function putRoastProfile(row: RoastProfile): Promise<void> {
  await db.roastProfiles.put(row);
}

/** 删除烘焙记录：级联删除曲线事件、杯测与排产锅次，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction('rw', db.roastProfiles, db.events, db.cuppings, db.blends, db.batchBookings, async () => {
    await db.events.where('profileId').equals(id).delete();
    await db.cuppings.where('profileId').equals(id).delete();
    await db.batchBookings.where('profileId').equals(id).delete();
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.profileId !== id);
        return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.roastProfiles.delete(id);
  });
}

/** 状态流转：记录中 → 已完成 / 作废 */
export async function updateRoastState(id: string, state: RoastState): Promise<void> {
  await db.roastProfiles.update(id, { state, updatedAt: nowIso() });
}

/* --------------------------- 曲线事件 RoastEvent --------------------------- */

export async function listEvents(profileId?: string): Promise<RoastEvent[]> {
  const rows = profileId
    ? await db.events.where('profileId').equals(profileId).toArray()
    : await db.events.toArray();
  return rows.sort((a, b) => a.atSec - b.atSec);
}

export async function listAllEvents(): Promise<RoastEvent[]> {
  return db.events.toArray();
}

export async function putEvent(row: RoastEvent): Promise<void> {
  await db.events.put(row);
}

export async function putEvents(rows: RoastEvent[]): Promise<void> {
  await db.events.bulkPut(rows);
}

export async function removeEvent(id: string): Promise<void> {
  await db.events.delete(id);
}

/* ----------------------------- 杯测 Cupping ----------------------------- */

export async function listCuppings(): Promise<Cupping[]> {
  const rows = await db.cuppings.toArray();
  return rows.sort((a, b) => b.cuppedAt.localeCompare(a.cuppedAt));
}

export async function putCupping(row: Cupping): Promise<void> {
  await db.cuppings.put(row);
}

export async function removeCupping(id: string): Promise<void> {
  await db.cuppings.delete(id);
}

/* ------------------------------ 拼配 Blend ------------------------------ */

export async function listBlends(): Promise<Blend[]> {
  const rows = await db.blends.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putBlend(row: Blend): Promise<void> {
  await db.blends.put(row);
}

export async function removeBlend(id: string): Promise<void> {
  await db.blends.delete(id);
}

/* -------------------------- 载量模板 MachineTemplate -------------------------- */

export async function listMachineTemplates(): Promise<MachineTemplate[]> {
  const rows = await db.machineTemplates.toArray();
  return rows.sort((a, b) => a.model.localeCompare(b.model, 'zh-Hans-CN') || a.chargeG - b.chargeG);
}

export async function putMachineTemplate(row: MachineTemplate): Promise<void> {
  await db.machineTemplates.put(row);
}

export async function removeMachineTemplate(id: string): Promise<void> {
  await db.machineTemplates.delete(id);
}

/* --------------------------- 下豆扣减在库重量 --------------------------- */

export interface StockConsumeResult {
  ok: boolean;
  message: string;
  /** 本次扣减重量（kg） */
  deductedKg: number;
  /** 扣减后余量（kg） */
  remainingKg: number;
  /** 余量是否低于警戒线 */
  warning: boolean;
  bean?: GreenBean;
  profile?: RoastProfile;
}

/**
 * 烘焙下豆后按载量自动扣减生豆在库重量，并把记录状态推进为「已完成」。
 * 只有「记录中」的记录允许扣减，避免重复扣减；余量不足时直接拒绝。
 * 排产账本：若该记录挂着「已排产」锅次，同步转为「已下豆」（预留转实际扣减）。
 */
export async function consumeStockForProfile(profileId: string): Promise<StockConsumeResult> {
  return db.transaction('rw', db.greenBeans, db.roastProfiles, db.batchBookings, async () => {
    const profile = await db.roastProfiles.get(profileId);
    if (!profile) {
      return { ok: false, message: '烘焙记录不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const bean = await db.greenBeans.get(profile.greenBeanId);
    if (!bean) {
      return { ok: false, message: '该烘焙记录关联的生豆已不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const deductedKg = roundKg(profile.chargeG / 1000);
    if (profile.state !== 'recording') {
      return {
        ok: false,
        message: `该记录当前为「${ROAST_STATE_LABEL[profile.state]}」，无需重复扣减`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: bean.stockKg < LOW_STOCK_KG,
        bean,
        profile,
      };
    }
    if (bean.stockKg + 1e-6 < deductedKg) {
      return {
        ok: false,
        message: `生豆余量不足：在库 ${bean.stockKg}kg < 本次载量 ${deductedKg}kg，请先补货或下调载量`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: true,
        bean,
        profile,
      };
    }
    const stamp = nowIso();
    const remainingKg = roundKg(bean.stockKg - deductedKg);
    const nextBean: GreenBean = { ...bean, stockKg: remainingKg, updatedAt: stamp };
    const nextProfile: RoastProfile = { ...profile, state: 'done', updatedAt: stamp };
    await db.greenBeans.put(nextBean);
    await db.roastProfiles.put(nextProfile);

    // 排产锅次：已排产 → 已下豆（预留随之消失，下豆已转成实际扣减）
    const bookings = await db.batchBookings.where('profileId').equals(profileId).toArray();
    await Promise.all(
      bookings
        .filter((booking) => booking.state === 'booked')
        .map((booking) =>
          db.batchBookings.put({
            ...booking,
            state: 'dropped',
            chargeG: profile.chargeG,
            updatedAt: stamp,
          } satisfies BatchBooking),
        ),
    );

    const warning = remainingKg < LOW_STOCK_KG;
    return {
      ok: true,
      message: `已按载量扣减 ${deductedKg}kg，${bean.farm || bean.origin} 余量 ${remainingKg}kg${
        warning ? '（余量偏低，请及时补货）' : ''
      }`,
      deductedKg,
      remainingKg,
      warning,
      bean: nextBean,
      profile: nextProfile,
    };
  });
}

/* ----------------------------- 整库导入导出 ----------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  greenBeans: GreenBean[];
  roastProfiles: RoastProfile[];
  events: RoastEvent[];
  cuppings: Cupping[];
  blends: Blend[];
  machineTemplates: MachineTemplate[];
  roasterMachines: RoasterMachine[];
  batchBookings: BatchBooking[];
}

/** 结构校验：判断任意对象是否为可导入的快照 */
export function isDatabaseSnapshot(value: unknown): value is DatabaseSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys: Array<keyof DatabaseSnapshot> = [
    'greenBeans',
    'roastProfiles',
    'events',
    'cuppings',
    'blends',
  ];
  return keys.every((key) => Array.isArray(candidate[key]));
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roasterMachines, batchBookings] =
    await Promise.all([
      db.greenBeans.toArray(),
      db.roastProfiles.toArray(),
      db.events.toArray(),
      db.cuppings.toArray(),
      db.blends.toArray(),
      db.machineTemplates.toArray(),
      db.roasterMachines.toArray(),
      db.batchBookings.toArray(),
    ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    greenBeans,
    roastProfiles,
    events,
    cuppings,
    blends,
    machineTemplates,
    roasterMachines,
    batchBookings,
  };
}

/** 用快照覆盖整库（导入档案） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  if (!isDatabaseSnapshot(snapshot)) {
    throw new Error('档案结构不合法：缺少 greenBeans / roastProfiles / events / cuppings / blends 数组字段');
  }
  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.roasterMachines,
      db.batchBookings,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.roasterMachines.clear(),
        db.batchBookings.clear(),
      ]);
      await db.greenBeans.bulkPut(snapshot.greenBeans);
      await db.roastProfiles.bulkPut(snapshot.roastProfiles);
      await db.events.bulkPut(snapshot.events);
      await db.cuppings.bulkPut(snapshot.cuppings);
      await db.blends.bulkPut(snapshot.blends);
      await db.machineTemplates.bulkPut(snapshot.machineTemplates ?? []);
      await db.roasterMachines.bulkPut(snapshot.roasterMachines ?? []);
      await db.batchBookings.bulkPut(snapshot.batchBookings ?? []);
    },
  );
}

/** 清空全部表 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.roasterMachines,
      db.batchBookings,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.roasterMachines.clear(),
        db.batchBookings.clear(),
      ]);
    },
  );
}

/** 重置为演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roasterMachines, batchBookings] =
    await Promise.all([
      db.greenBeans.count(),
      db.roastProfiles.count(),
      db.events.count(),
      db.cuppings.count(),
      db.blends.count(),
      db.machineTemplates.count(),
      db.roasterMachines.count(),
      db.batchBookings.count(),
    ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roasterMachines, batchBookings };
}

/* ------------------------------ 首屏初始化 ------------------------------ */

/** 打开数据库：空库时自动播种演示数据，保证每个页面开箱即有内容 */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.greenBeans.count()) === 0) {
    await seedDatabase();
  }
}

/**
 * 播种演示数据（幂等：固定 id + bulkPut）。
 * 层次：生豆 → 烘焙记录 → 曲线事件 / 杯测 → 拼配方案（→ 表示父引用子）。
 */
export async function seedDatabase(): Promise<void> {
  const existing = await db.greenBeans.count();
  if (existing > 0) return;

  const stamp = nowIso();
  // 以今天为锚点（offset - 14 为两周前）：历史烘焙在过去，排产演示在今天/明天，开箱即看到账本占用。
  const day = (offset: number): string => addDaysLocal(todayLocal(), offset - 14);

  const greenBeans: GreenBean[] = [
    {
      id: 'gb-guji-washed',
      origin: '埃塞俄比亚 古吉',
      farm: '乌拉嘎水洗站',
      process: 'washed',
      altitudeM: 2050,
      moisturePct: 10.8,
      stockKg: 12.5,
      arrivedAt: day(-52),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-huila-honey',
      origin: '哥伦比亚 惠兰',
      farm: '圣安东尼奥庄园',
      process: 'honey',
      altitudeM: 1750,
      moisturePct: 11.2,
      stockKg: 1.4,
      arrivedAt: day(-38),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-cerrado-natural',
      origin: '巴西 喜拉多',
      farm: '圣伊莎贝尔庄园',
      process: 'natural',
      altitudeM: 1150,
      moisturePct: 11.6,
      stockKg: 20,
      arrivedAt: day(-22),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-nyeri-washed',
      origin: '肯尼亚 涅里',
      farm: '加图吉处理厂',
      process: 'washed',
      altitudeM: 1850,
      moisturePct: 10.4,
      stockKg: 6.4,
      arrivedAt: day(-10),
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const roastProfiles: RoastProfile[] = [
    {
      id: 'rp-guji-500',
      greenBeanId: 'gb-guji-washed',
      machineModel: 'HB-M6',
      chargeG: 500,
      chargeTempC: 198,
      airflow: 'half',
      gasLevel: 4,
      roastedAt: day(2),
      state: 'done',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-huila-800',
      greenBeanId: 'gb-huila-honey',
      machineModel: 'Giesen W6A',
      chargeG: 800,
      chargeTempC: 205,
      airflow: 'open',
      gasLevel: 5,
      roastedAt: day(6),
      state: 'recording',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-cerrado-1200',
      greenBeanId: 'gb-cerrado-natural',
      machineModel: 'Probat P12',
      chargeG: 1200,
      chargeTempC: 195,
      airflow: 'half',
      gasLevel: 6,
      roastedAt: day(10),
      state: 'done',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-nyeri-400',
      greenBeanId: 'gb-nyeri-washed',
      machineModel: 'Mill City 500g',
      chargeG: 400,
      chargeTempC: 200,
      airflow: 'closed',
      gasLevel: 3,
      roastedAt: day(12),
      state: 'void',
      createdAt: stamp,
      updatedAt: stamp,
    },

    // —— 今天的排产演示：HB-M6 当天 6 锅排满（4 锅已下豆 + 2 锅已排产预留）——
    ...([
      ['rp-today-guji-1', 'gb-guji-washed', 500, 'done'],
      ['rp-today-guji-2', 'gb-guji-washed', 500, 'done'],
      ['rp-today-guji-3', 'gb-guji-washed', 500, 'done'],
      ['rp-today-guji-4', 'gb-guji-washed', 500, 'done'],
      ['rp-today-guji-5', 'gb-guji-washed', 500, 'recording'],
      ['rp-today-guji-6', 'gb-guji-washed', 600, 'recording'],
    ] as Array<[string, string, number, RoastProfile['state']]>).map<RoastProfile>(([id, greenBeanId, chargeG, state]) => ({
      id,
      greenBeanId,
      machineModel: 'HB-M6',
      chargeG,
      chargeTempC: 198,
      airflow: 'half',
      gasLevel: 4,
      roastedAt: day(14),
      state,
      createdAt: stamp,
      updatedAt: stamp,
    })),
    {
      id: 'rp-today-cerrado-giesen',
      greenBeanId: 'gb-cerrado-natural',
      machineModel: 'Giesen W6A',
      chargeG: 800,
      chargeTempC: 205,
      airflow: 'open',
      gasLevel: 5,
      roastedAt: day(14),
      state: 'recording',
      createdAt: stamp,
      updatedAt: stamp,
    },
    // —— 明天：HB-M6 今日排满后顺延到次日的一锅 ——
    {
      id: 'rp-tomorrow-nyeri-probat',
      greenBeanId: 'gb-nyeri-washed',
      machineModel: 'Probat P12',
      chargeG: 1000,
      chargeTempC: 195,
      airflow: 'half',
      gasLevel: 6,
      roastedAt: day(15),
      state: 'recording',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const eventSeed: Array<[string, string, RoastEvent['type'], number, number, string]> = [
    ['ev-guji-1', 'rp-guji-500', 'turning', 95, 118.2, '回温点，火力保持 4 档'],
    ['ev-guji-2', 'rp-guji-500', 'dryEnd', 288, 152.6, '脱水结束转黄，风门调半开'],
    ['ev-guji-3', 'rp-guji-500', 'firstCrack', 462, 196.4, '一爆密集，火力回调至 3 档'],
    ['ev-guji-4', 'rp-guji-500', 'secondCrack', 640, 214.2, '二爆初起，准备下豆'],
    ['ev-guji-5', 'rp-guji-500', 'drop', 700, 219.5, '下豆冷却，发展率 34%'],
    ['ev-huila-1', 'rp-huila-800', 'turning', 102, 121, '回温偏晚，火力 5 档'],
    ['ev-huila-2', 'rp-huila-800', 'dryEnd', 305, 149.8, '蜜处理脱水稍慢'],
    ['ev-huila-3', 'rp-huila-800', 'firstCrack', 496, 193.5, '一爆清晰，待补录二爆与下豆'],
    ['ev-cerrado-1', 'rp-cerrado-1200', 'turning', 110, 116.4, '满锅载量，回温 110 秒'],
    ['ev-cerrado-2', 'rp-cerrado-1200', 'dryEnd', 330, 150.2, '脱水结束，火力维持 6 档'],
    ['ev-cerrado-3', 'rp-cerrado-1200', 'firstCrack', 540, 194.8, '一爆均匀'],
    ['ev-cerrado-4', 'rp-cerrado-1200', 'secondCrack', 720, 212.6, '二爆，风门半开'],
    ['ev-cerrado-5', 'rp-cerrado-1200', 'drop', 780, 217.2, '下豆，发展率 30.8%'],
    ['ev-nyeri-1', 'rp-nyeri-400', 'turning', 118, 114.5, '风门关，回温慢'],
    ['ev-nyeri-2', 'rp-nyeri-400', 'dryEnd', 372, 131.8, '脱水期过长、RoR 偏低，判定作废重烘'],
  ];

  const events: RoastEvent[] = eventSeed.map(([id, profileId, type, atSec, beanTempC, note]) => ({
    id,
    profileId,
    type,
    atSec,
    beanTempC,
    rorPerMin: 0,
    note,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  // 按时间顺序补算 RoR（播种后就带上真实速率，页面直接可用）
  const grouped = new Map<string, RoastEvent[]>();
  events.forEach((event) => {
    const list = grouped.get(event.profileId) ?? [];
    list.push(event);
    grouped.set(event.profileId, list);
  });
  grouped.forEach((list) => {
    list.sort((a, b) => a.atSec - b.atSec);
    list.forEach((event, index) => {
      const prev = list[index - 1];
      event.rorPerMin = prev
        ? rorPerMinBetween(prev.atSec, prev.beanTempC, event.atSec, event.beanTempC)
        : 0;
    });
  });

  const buildCupping = (
    id: string,
    profileId: string,
    cuppedAt: string,
    dryAroma: number,
    wetAroma: number,
    acidity: number,
    sweetness: number,
    aftertaste: number,
  ): Cupping => ({
    id,
    profileId,
    cuppedAt,
    dryAroma,
    wetAroma,
    acidity,
    sweetness,
    aftertaste,
    totalScore: weightedTotalScore({ dryAroma, wetAroma, acidity, sweetness, aftertaste }),
    createdAt: stamp,
    updatedAt: stamp,
  });

  const cuppings: Cupping[] = [
    buildCupping('cp-guji-01', 'rp-guji-500', day(4), 8.5, 8.8, 8.6, 8.9, 8.4),
    buildCupping('cp-cerrado-01', 'rp-cerrado-1200', day(12), 8.2, 8.4, 7.8, 8.8, 8.6),
    buildCupping('cp-huila-01', 'rp-huila-800', day(9), 7.9, 8.1, 7.4, 8.2, 7.8),
  ];

  const blends: Blend[] = [
    {
      id: 'bl-house-01',
      name: '晨光拼配 House Blend',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 40 },
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 45 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 15 },
      ],
      targetFlavor: '柑橘果酸、坚果可可',
      createdAt: day(15),
      state: 'final',
      updatedAt: stamp,
    },
    {
      id: 'bl-espresso-02',
      name: '深烘意式 Espresso Base',
      items: [
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 70 },
        { greenBeanId: 'gb-nyeri-washed', profileId: 'rp-nyeri-400', ratioPct: 30 },
      ],
      targetFlavor: '坚果可可、焦糖甜感',
      createdAt: day(23),
      state: 'trial',
      updatedAt: stamp,
    },
    {
      id: 'bl-draft-03',
      name: '实验批次（占比待调平）',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 50 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 30 },
      ],
      targetFlavor: '花香、莓果',
      createdAt: day(27),
      state: 'trial',
      updatedAt: stamp,
    },
  ];

  const machineTemplates: MachineTemplate[] = [
    {
      id: 'mt-hb-m6',
      model: 'HB-M6',
      airflow: 'half',
      gasLevel: 4,
      chargeG: 500,
      note: '常规出品载量',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-giesen-w6a',
      model: 'Giesen W6A',
      airflow: 'open',
      gasLevel: 5,
      chargeG: 800,
      note: '满锅载量，适合日晒豆',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-probat-p12',
      model: 'Probat P12',
      airflow: 'half',
      gasLevel: 6,
      chargeG: 1200,
      note: '批量生产档',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-millcity-500',
      model: 'Mill City 500g',
      airflow: 'closed',
      gasLevel: 3,
      chargeG: 400,
      note: '样品烘焙，风门关',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // —— 排产账本：烘焙机（当天锅次上限）——
  const roasterMachines: RoasterMachine[] = [
    {
      id: 'rm-hb-m6',
      model: 'HB-M6',
      dailyLimit: 6,
      slotMinutes: 30,
      openFrom: '08:30',
      openTo: '18:00',
      note: '出品主力机，每天 6 锅',
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rm-giesen-w6a',
      model: 'Giesen W6A',
      dailyLimit: 8,
      slotMinutes: 30,
      openFrom: '09:00',
      openTo: '18:00',
      note: '满锅批次用',
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rm-probat-p12',
      model: 'Probat P12',
      dailyLimit: 4,
      slotMinutes: 45,
      openFrom: '08:00',
      openTo: '17:00',
      note: '批量生产，单锅时长长',
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rm-millcity-500',
      model: 'Mill City 500g',
      dailyLimit: 10,
      slotMinutes: 20,
      openFrom: '09:30',
      openTo: '17:30',
      note: '样品烘焙机',
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // —— 锅次占用单：历史锅次 + 今天 6 锅（HB-M6 排满）+ 明天顺延 1 锅 ——
  const today = day(14);
  const tomorrow = day(15);
  const buildBooking = (
    id: string,
    machineId: string,
    machineModel: string,
    greenBeanId: string,
    profileId: string,
    planDate: string,
    slotAt: string,
    chargeG: number,
    operator: string,
    state: BatchBooking['state'],
    note: string,
    deferred = false,
  ): BatchBooking => ({
    id,
    machineId,
    machineModel,
    greenBeanId,
    profileId,
    planDate,
    slotAt,
    chargeG,
    operator,
    state,
    note,
    slotKey: state === 'void' ? undefined : makeSlotKey(machineId, planDate, slotAt),
    deferred,
    createdAt: stamp,
    updatedAt: stamp,
  });

  const batchBookings: BatchBooking[] = [
    buildBooking('bk-guji-done', 'rm-hb-m6', 'HB-M6', 'gb-guji-washed', 'rp-guji-500', day(2), '10:00', 500, '阿May', 'dropped', '历史已下豆'),
    buildBooking('bk-cerrado-done', 'rm-probat-p12', 'Probat P12', 'gb-cerrado-natural', 'rp-cerrado-1200', day(10), '09:30', 1200, '老周', 'dropped', '历史已下豆'),
    buildBooking('bk-nyeri-void', 'rm-millcity-500', 'Mill City 500g', 'gb-nyeri-washed', 'rp-nyeri-400', day(12), '14:00', 400, '阿May', 'void', '脱水异常作废，预留已归还'),

    // 今天 HB-M6：6 锅排满（前 4 锅已下豆，后 2 锅已排产并预留古吉生豆 1.1kg）
    ...(['rp-today-guji-1', 'rp-today-guji-2', 'rp-today-guji-3', 'rp-today-guji-4'].map((profileId, index) =>
      buildBooking(
        `bk-${profileId}`,
        'rm-hb-m6',
        'HB-M6',
        'gb-guji-washed',
        profileId,
        today,
        ['08:30', '09:00', '09:30', '10:00'][index],
        500,
        index % 2 === 0 ? '阿May' : '老周',
        'dropped',
        '今日出品',
      ),
    )),
    buildBooking('bk-rp-today-guji-5', 'rm-hb-m6', 'HB-M6', 'gb-guji-washed', 'rp-today-guji-5', today, '10:30', 500, '阿May', 'booked', '待开烘'),
    buildBooking('bk-rp-today-guji-6', 'rm-hb-m6', 'HB-M6', 'gb-guji-washed', 'rp-today-guji-6', today, '11:00', 600, '老周', 'booked', '满锅'),
    buildBooking('bk-rp-today-cerrado-giesen', 'rm-giesen-w6a', 'Giesen W6A', 'gb-cerrado-natural', 'rp-today-cerrado-giesen', today, '13:30', 800, '老周', 'booked', '日晒满锅'),

    // 明天：P12 顺延锅次
    buildBooking(
      'bk-rp-tomorrow-nyeri-probat',
      'rm-probat-p12',
      'Probat P12',
      'gb-nyeri-washed',
      'rp-tomorrow-nyeri-probat',
      tomorrow,
      '08:00',
      1000,
      '阿May',
      'booked',
      '昨天 P12 已满，顺延次日',
      true,
    ),
  ];

  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.roasterMachines,
      db.batchBookings,
    ],
    async () => {
      await db.greenBeans.bulkPut(greenBeans);
      await db.roastProfiles.bulkPut(roastProfiles);
      await db.events.bulkPut(events);
      await db.cuppings.bulkPut(cuppings);
      await db.blends.bulkPut(blends);
      await db.machineTemplates.bulkPut(machineTemplates);
      await db.roasterMachines.bulkPut(roasterMachines);
      await db.batchBookings.bulkPut(batchBookings);
    },
  );
}

/* ====================================================================== */
/*                         排产账本（v3 新增）                              */
/* ====================================================================== */

/* --------------------------- 烘焙机（锅次上限） --------------------------- */

export async function listRoasterMachines(): Promise<RoasterMachine[]> {
  const rows = await db.roasterMachines.toArray();
  return rows.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.model.localeCompare(b.model, 'zh-Hans-CN'),
  );
}

export async function putRoasterMachine(row: RoasterMachine): Promise<void> {
  await db.roasterMachines.put(row);
}

/**
 * 删除烘焙机：只允许删除「没有占用中锅次（已排产/已下豆）」的机器，历史账本要可追溯。
 * 若仅存在作废锅次，一并清理。
 */
export async function removeRoasterMachine(id: string): Promise<void> {
  await db.transaction('rw', db.roasterMachines, db.batchBookings, async () => {
    const active = await db.batchBookings
      .where('machineId')
      .equals(id)
      .filter((booking) => booking.state !== 'void')
      .count();
    if (active > 0) {
      throw new ScheduleRuleError(`该烘焙机还有 ${active} 锅占用中（已排产/已下豆），不能删除；可改为停用`);
    }
    await db.batchBookings.where('machineId').equals(id).delete();
    await db.roasterMachines.delete(id);
  });
}

/* ----------------------------- 锅次占用单 ----------------------------- */

export async function listBatchBookings(): Promise<BatchBooking[]> {
  const rows = await db.batchBookings.toArray();
  return rows.sort((a, b) =>
    a.planDate === b.planDate ? a.slotAt.localeCompare(b.slotAt) : a.planDate.localeCompare(b.planDate),
  );
}

export async function getBatchBooking(id: string): Promise<BatchBooking | undefined> {
  return db.batchBookings.get(id);
}

/** 判断 Dexie 抛出的是否为唯一索引冲突（slotKey 被并发抢先） */
function isConstraintError(cause: unknown): boolean {
  return Boolean(
    cause &&
      typeof cause === 'object' &&
      'name' in cause &&
      (cause as { name?: string }).name === 'ConstraintError',
  );
}

export interface SubmitBookingInput {
  machineId: string;
  greenBeanId: string;
  planDate: string;
  slotAt: string;
  chargeG: number;
  operator: string;
  note: string;
  /** 已存在的「记录中」烘焙记录（补排）；不传则新建烘焙记录 */
  profileId?: string;
}

export interface SubmitBookingResult {
  booking: BatchBooking;
  /** 实际落单日期（当天排满顺延时与提交日期不同） */
  deferred: boolean;
  message: string;
}

/**
 * 提交锅次（原子事务）：
 * - 校验机器 / 生豆 / 载量 / 可用余量（在库 - 其它已排预留）。
 * - 目标时段若已被占：直接拒绝并返回占用者（不换时段），晚到的一单看到被谁占了。
 * - 当天锅次排满：向后逐天找「既有空时段又未达上限」的一天顺延（最多 14 天）。
 * - 同事务建/挂烘焙记录（记录中）。唯一索引 slotKey 兜底跨标签页并发只成功一单。
 */
export async function submitBatchBooking(input: SubmitBookingInput): Promise<SubmitBookingResult> {
  const chargeG = Math.round(input.chargeG);
  const operator = input.operator.trim();
  const note = input.note.trim();

  try {
    return await db.transaction(
      'rw',
      db.roasterMachines,
      db.greenBeans,
      db.roastProfiles,
      db.batchBookings,
      async () => {
        const machine = await db.roasterMachines.get(input.machineId);
        if (!machine || !machine.enabled) throw new ScheduleRuleError('烘焙机不存在或已停用');
        const bean = await db.greenBeans.get(input.greenBeanId);
        if (!bean) throw new ScheduleRuleError('生豆批次不存在');
        if (!Number.isFinite(chargeG) || chargeG < 50) throw new ScheduleRuleError('载量不合法（至少 50g）');
        if (!operator) throw new ScheduleRuleError('请填写排单烘焙师');

        const all = await db.batchBookings.toArray();
        const needKg = gToKg(chargeG);
        const freeKg = availableKg(all, bean.stockKg, bean.id);
        if (freeKg + 1e-6 < needKg) {
          throw new ScheduleRuleError(
            `生豆可用余量不足：在库 ${bean.stockKg}kg，已排预留 ${roundKg(bean.stockKg - freeKg)}kg，可用 ${freeKg}kg < 本锅 ${needKg}kg`,
          );
        }

        // 1) 目标时段冲突：不换时段，直接拒绝并告知占用者
        const requestedKey = makeSlotKey(machine.id, input.planDate, input.slotAt);
        const holder = all.find((booking) => booking.slotKey === requestedKey);
        if (holder) throw new SlotConflictError(holder);

        // 2) 当天锅次排满：向后顺延找首个「该时段空闲且未达上限」的日期
        let planDate = input.planDate;
        let deferred = false;
        const occupiedKeys = new Set(all.filter((b) => b.slotKey).map((b) => b.slotKey));
        if (isDayFull(all, machine, planDate)) {
          let found = false;
          for (let offset = 1; offset <= 14; offset += 1) {
            const candidate = addDaysLocal(input.planDate, offset);
            const candidateKey = makeSlotKey(machine.id, candidate, input.slotAt);
            if (!occupiedKeys.has(candidateKey) && !isDayFull(all, machine, candidate)) {
              planDate = candidate;
              deferred = true;
              found = true;
              break;
            }
          }
          if (!found) throw new ScheduleRuleError('未来 14 天该机型锅次均已排满，请联系烘焙主管调整锅次上限');
        }

        const stamp = nowIso();

        // 3) 关联烘焙记录：补排则校验并复用；否则新建一条「记录中」记录
        let profileId = input.profileId;
        if (profileId) {
          const existing = await db.roastProfiles.get(profileId);
          if (!existing) throw new ScheduleRuleError('要补排的烘焙记录不存在');
          if (existing.state !== 'recording') {
            throw new ScheduleRuleError(`该烘焙记录当前为「${ROAST_STATE_LABEL[existing.state]}」，不能再排产`);
          }
          const linked = all.find((booking) => booking.profileId === profileId && booking.state !== 'void');
          if (linked) throw new ScheduleRuleError('该烘焙记录已排进锅次，不能重复占用');
          await db.roastProfiles.put({
            ...existing,
            machineModel: machine.model,
            chargeG,
            updatedAt: stamp,
          });
        } else {
          const profile: RoastProfile = {
            id: createId('rp'),
            greenBeanId: bean.id,
            machineModel: machine.model,
            chargeG,
            chargeTempC: 200,
            airflow: 'half',
            gasLevel: 4,
            roastedAt: planDate,
            state: 'recording',
            createdAt: stamp,
            updatedAt: stamp,
          };
          await db.roastProfiles.put(profile);
          profileId = profile.id;
        }

        const booking: BatchBooking = {
          id: createId('bk'),
          machineId: machine.id,
          machineModel: machine.model,
          greenBeanId: bean.id,
          profileId,
          planDate,
          slotAt: input.slotAt,
          chargeG,
          operator,
          state: 'booked',
          note,
          slotKey: makeSlotKey(machine.id, planDate, input.slotAt),
          deferred,
          createdAt: stamp,
          updatedAt: stamp,
        };
        await db.batchBookings.put(booking);

        return {
          booking,
          deferred,
          message: deferred
            ? `${machine.model} ${input.planDate} 锅次已满，已顺延到 ${planDate} ${input.slotAt}，并预留 ${needKg}kg 生豆`
            : `排产成功：${machine.model} ${planDate} ${input.slotAt}，已从可用余量预留 ${needKg}kg`,
        };
      },
    );
  } catch (cause) {
    // 并发兜底：两个标签页同一时段同时 put，败方唯一索引报错 → 查出占用者抛出
    if (isConstraintError(cause)) {
      const key = makeSlotKey(input.machineId, input.planDate, input.slotAt);
      const occupant = await db.batchBookings.where('slotKey').equals(key).first();
      if (occupant) throw new SlotConflictError(occupant);
    }
    throw cause;
  }
}

/** 下豆完成：已排产 → 已下豆；同事务按载量实际扣减生豆在库重量（预留转实际扣减）。 */
export async function dropBooking(id: string): Promise<{ booking: BatchBooking; message: string }> {
  return db.transaction('rw', db.batchBookings, db.roastProfiles, db.greenBeans, async () => {
    const booking = await db.batchBookings.get(id);
    if (!booking) throw new ScheduleRuleError('锅次不存在');
    if (booking.state !== 'booked') {
      throw new ScheduleRuleError(
        `只有「${BOOKING_STATE_LABEL.booked}」锅次能下豆，当前为「${BOOKING_STATE_LABEL[booking.state]}」`,
      );
    }
    const bean = await db.greenBeans.get(booking.greenBeanId);
    if (!bean) throw new ScheduleRuleError('关联生豆已不存在');
    const deductedKg = gToKg(booking.chargeG);
    if (bean.stockKg + 1e-6 < deductedKg) {
      throw new ScheduleRuleError(`生豆在库 ${bean.stockKg}kg < 载量 ${deductedKg}kg，无法下豆扣减，请先补货`);
    }
    const stamp = nowIso();
    const remainingKg = roundKg(bean.stockKg - deductedKg);
    await db.greenBeans.put({ ...bean, stockKg: remainingKg, updatedAt: stamp });

    const profile = booking.profileId ? await db.roastProfiles.get(booking.profileId) : undefined;
    if (profile) await db.roastProfiles.put({ ...profile, state: 'done', chargeG: booking.chargeG, updatedAt: stamp });

    const next: BatchBooking = { ...booking, state: 'dropped', updatedAt: stamp };
    await db.batchBookings.put(next);
    return {
      booking: next,
      message: `已下豆：实际扣减 ${deductedKg}kg，余量 ${remainingKg}kg${
        remainingKg < LOW_STOCK_KG ? '（余量偏低）' : ''
      }`,
    };
  });
}

/** 作废锅次：释放时段占用（删 slotKey），状态一改预留立即重算归还；关联烘焙记录同步作废。 */
export async function voidBooking(id: string): Promise<{ booking: BatchBooking; message: string }> {
  return db.transaction('rw', db.batchBookings, db.roastProfiles, async () => {
    const booking = await db.batchBookings.get(id);
    if (!booking) throw new ScheduleRuleError('锅次不存在');
    if (booking.state === 'void') throw new ScheduleRuleError('该锅次已作废');
    const stamp = nowIso();
    const { slotKey: _slotKey, ...rest } = booking;
    const next: BatchBooking = { ...rest, state: 'void', updatedAt: stamp };
    await db.batchBookings.put(next);
    if (booking.profileId) {
      const profile = await db.roastProfiles.get(booking.profileId);
      if (profile && profile.state !== 'void') {
        await db.roastProfiles.put({ ...profile, state: 'void', updatedAt: stamp });
      }
    }
    return { booking: next, message: `锅次已作废，时段已释放，预留的 ${gToKg(booking.chargeG)}kg 已归还可用余量` };
  });
}

/** 恢复作废锅次：重新校验锅次上限、时段占用与生豆可用余量。 */
export async function restoreBooking(id: string): Promise<{ booking: BatchBooking; message: string }> {
  try {
    return await db.transaction(
      'rw',
      db.batchBookings,
      db.roasterMachines,
      db.greenBeans,
      db.roastProfiles,
      async () => {
        const booking = await db.batchBookings.get(id);
        if (!booking) throw new ScheduleRuleError('锅次不存在');
        if (booking.state !== 'void') throw new ScheduleRuleError('只有已作废锅次能恢复');
        const machine = await db.roasterMachines.get(booking.machineId);
        if (!machine || !machine.enabled) throw new ScheduleRuleError('烘焙机不存在或已停用');
        const all = await db.batchBookings.toArray();
        const key = makeSlotKey(machine.id, booking.planDate, booking.slotAt);
        const holder = all.find((item) => item.slotKey === key);
        if (holder) throw new SlotConflictError(holder);
        if (isDayFull(all, machine, booking.planDate)) {
          throw new ScheduleRuleError(`${booking.planDate} ${machine.model} 锅次已排满，无法恢复到当天`);
        }
        const bean = await db.greenBeans.get(booking.greenBeanId);
        if (bean) {
          const freeKg = availableKg(all, bean.stockKg, bean.id);
          if (freeKg + 1e-6 < gToKg(booking.chargeG)) {
            throw new ScheduleRuleError(`生豆可用余量不足（可用 ${freeKg}kg < ${gToKg(booking.chargeG)}kg），无法恢复预留`);
          }
        }
        const stamp = nowIso();
        const next: BatchBooking = { ...booking, state: 'booked', slotKey: key, updatedAt: stamp };
        await db.batchBookings.put(next);
        if (booking.profileId) {
          const profile = await db.roastProfiles.get(booking.profileId);
          if (profile && profile.state === 'void') {
            await db.roastProfiles.put({ ...profile, state: 'recording', updatedAt: stamp });
          }
        }
        return { booking: next, message: `锅次已恢复为「已排产」，重新预留 ${gToKg(booking.chargeG)}kg 生豆` };
      },
    );
  } catch (cause) {
    if (isConstraintError(cause)) {
      const booking = await getBatchBooking(id);
      if (booking) {
        const key = makeSlotKey(booking.machineId, booking.planDate, booking.slotAt);
        const occupant = await db.batchBookings.where('slotKey').equals(key).first();
        if (occupant) throw new SlotConflictError(occupant);
      }
    }
    throw cause;
  }
}

/**
 * 改动载量：预留与占用提示马上重算。
 * 校验可用余量（排除自身）；同事务同步关联烘焙记录载量。
 */
export async function changeBookingCharge(
  id: string,
  chargeG: number,
): Promise<{ booking: BatchBooking; message: string }> {
  return db.transaction('rw', db.batchBookings, db.greenBeans, db.roastProfiles, async () => {
    const booking = await db.batchBookings.get(id);
    if (!booking) throw new ScheduleRuleError('锅次不存在');
    const nextCharge = Math.round(chargeG);
    if (!Number.isFinite(nextCharge) || nextCharge < 50) throw new ScheduleRuleError('载量不合法（至少 50g）');
    const bean = await db.greenBeans.get(booking.greenBeanId);
    if (!bean) throw new ScheduleRuleError('关联生豆已不存在');
    if (booking.state === 'booked') {
      const all = await db.batchBookings.toArray();
      const freeKg = availableKg(all, bean.stockKg, bean.id, booking.id);
      if (freeKg + 1e-6 < gToKg(nextCharge)) {
        throw new ScheduleRuleError(`可用余量不足：可用 ${freeKg}kg，改后需预留 ${gToKg(nextCharge)}kg`);
      }
    }
    const stamp = nowIso();
    const next: BatchBooking = { ...booking, chargeG: nextCharge, updatedAt: stamp };
    await db.batchBookings.put(next);
    if (booking.profileId) {
      const profile = await db.roastProfiles.get(booking.profileId);
      if (profile) await db.roastProfiles.put({ ...profile, chargeG: nextCharge, updatedAt: stamp });
    }
    return {
      booking: next,
      message:
        booking.state === 'booked'
          ? `载量已改为 ${nextCharge}g，预留已按新载量重算为 ${gToKg(nextCharge)}kg`
          : `载量已改为 ${nextCharge}g`,
    };
  });
}

/** 删除锅次（作废单清理用）；占用中锅次请走下豆/作废。 */
export async function removeBatchBooking(id: string): Promise<void> {
  await db.transaction('rw', db.batchBookings, async () => {
    const booking = await db.batchBookings.get(id);
    if (booking && booking.state !== 'void') {
      throw new ScheduleRuleError('占用中的锅次不能直接删除，请先作废或下豆');
    }
    await db.batchBookings.delete(id);
  });
}

/**
 * 烘焙记录状态流转（排产账本感知版），供 /machines、/curves 的通用「作废/恢复」按钮复用。
 * - → void：若挂着已排产锅次，走锅次作废（释放时段、归还预留）；已下豆锅次的作废不回补实际扣减。
 * - void → recording：尝试恢复锅次（重算占用/预留，失败会带原因拒绝）。
 */
export async function transitionProfileStateBookingAware(
  profileId: string,
  state: RoastState,
): Promise<{ ok: boolean; message: string }> {
  if (state === 'void') {
    return db.transaction('rw', db.roastProfiles, db.batchBookings, async () => {
      const linked = await db.batchBookings.where('profileId').equals(profileId).toArray();
      const booked = linked.find((booking) => booking.state === 'booked');
      const stamp = nowIso();
      if (booked) {
        const { slotKey: _slotKey, ...rest } = booked;
        await db.batchBookings.put({ ...rest, state: 'void', updatedAt: stamp });
      }
      await db.roastProfiles.update(profileId, { state: 'void', updatedAt: stamp });
      return {
        ok: true,
        message: booked ? `已作废，锅次时段释放，预留 ${gToKg(booked.chargeG)}kg 已归还` : '烘焙记录已作废',
      };
    });
  }
  if (state === 'recording') {
    const linked = await db.batchBookings.where('profileId').equals(profileId).toArray();
    const voided = linked.find((booking) => booking.state === 'void');
    if (voided) {
      const result = await restoreBooking(voided.id);
      return { ok: true, message: result.message };
    }
    await updateRoastState(profileId, 'recording');
    return { ok: true, message: '记录已恢复为「记录中」' };
  }
  await updateRoastState(profileId, state);
  return { ok: true, message: '状态已更新' };
}
