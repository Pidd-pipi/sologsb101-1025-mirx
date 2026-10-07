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
import type { MachineCapacity, PotState, SchedulePot } from '../types/schedule';
import { DEFAULT_DAILY_POT_LIMIT, DEFAULT_OPERATOR_NAME, MAX_SCHEDULE_LOOKAHEAD_DAYS } from '../types/schedule';
import {
  addDays,
  findEarliestSlot,
  occupiedPotSet,
  potLimitFor,
  reservedKgOfBean,
  type SlotRef,
} from './schedule';
import { rorPerMinBetween } from './curve';

/** 数据库名（= 项目英文短名） */
export const DB_NAME = 'gbroastlog';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

class RoastLogDatabase extends Dexie {
  greenBeans!: Table<GreenBean, string>;
  roastProfiles!: Table<RoastProfile, string>;
  events!: Table<RoastEvent, string>;
  cuppings!: Table<Cupping, string>;
  blends!: Table<Blend, string>;
  machineTemplates!: Table<MachineTemplate, string>;
  machineCapacity!: Table<MachineCapacity, string>;
  /** 锅次占用账：复合主键 [machineModel+scheduledDate+potIndex] 保证同机型同天同锅次唯一 */
  schedulePots!: Table<SchedulePot, [string, string, number]>;

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
    this.version(2)
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

    // v3：排产台账 —— 机型日锅次上限表 + 锅次占用账表（复合主键保证同机型同天同锅次唯一），
    //      并把历史烘焙记录回填成锅次账（已完成→已扣减、记录中→预留中、作废→已作废）
    this.version(3)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
        machineCapacity: 'model, dailyPotLimit, updatedAt',
        schedulePots:
          '[machineModel+scheduledDate+potIndex], id, profileId, greenBeanId, state, scheduledDate, machineModel, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 为出现过的机型补默认日锅次上限（已有配置的不动）
        const capTable = tx.table('machineCapacity');
        const existingCaps = (await capTable.toArray()) as Array<Record<string, unknown>>;
        const configuredModels = new Set(existingCaps.map((row) => String(row.model)));
        const profileRows = (await tx.table('roastProfiles').toArray()) as RoastProfile[];
        const templateRows = (await tx.table('machineTemplates').toArray()) as MachineTemplate[];
        const models = new Set<string>();
        profileRows.forEach((profile) => {
          if (typeof profile.machineModel === 'string' && profile.machineModel) models.add(profile.machineModel);
        });
        templateRows.forEach((template) => {
          if (typeof template.model === 'string' && template.model) models.add(template.model);
        });
        const defaultLimitByModel: Record<string, number> = {
          'HB-M6': 4,
          'Giesen W6A': 3,
          'Probat P12': 2,
          'Mill City 500g': 6,
        };
        const newCaps: MachineCapacity[] = Array.from(models)
          .filter((model) => !configuredModels.has(model))
          .map((model) => ({
            model,
            dailyPotLimit: defaultLimitByModel[model] ?? DEFAULT_DAILY_POT_LIMIT,
            createdAt: stamp,
            updatedAt: stamp,
          }));
        if (newCaps.length > 0) await capTable.bulkPut(newCaps);

        // 2) 回填锅次账：每条没有锅的烘焙记录补一口锅，状态随记录
        const allCaps = (await capTable.toArray()) as MachineCapacity[];
        const existingPots = (await tx.table('schedulePots').toArray()) as SchedulePot[];
        const potsToAdd = buildSchedulePotsForProfiles(
          profileRows,
          existingPots,
          allCaps,
          stamp,
          DEFAULT_OPERATOR_NAME,
        );
        if (potsToAdd.length > 0) await tx.table('schedulePots').bulkPut(potsToAdd);
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

/* --------------------------- 排产台账：纯计算辅助 --------------------------- */

/**
 * 为尚无锅次的烘焙记录补锅（播种与 v3 迁移共用）。
 * 按烘焙日期排序后依次找最早空锅，锅状态随记录：done→已扣减 / recording→预留中 / void→已作废。
 */
function buildSchedulePotsForProfiles(
  profiles: RoastProfile[],
  existingPots: SchedulePot[],
  capacities: MachineCapacity[],
  stamp: string,
  operatorName: string,
): SchedulePot[] {
  const pots: SchedulePot[] = [...existingPots];
  const havePot = new Set(existingPots.map((pot) => pot.profileId));
  const sorted = [...profiles].sort((a, b) => a.roastedAt.localeCompare(b.roastedAt));
  const toAdd: SchedulePot[] = [];
  for (const profile of sorted) {
    if (havePot.has(profile.id)) continue;
    const limit = potLimitFor(profile.machineModel, capacities);
    const slot = findEarliestSlot(pots, profile.machineModel, profile.roastedAt, limit);
    if (!slot) continue;
    const state: PotState =
      profile.state === 'done' ? 'consumed' : profile.state === 'void' ? 'void' : 'reserved';
    const pot: SchedulePot = {
      id: createId('pot'),
      machineModel: profile.machineModel,
      scheduledDate: slot.date,
      potIndex: slot.potIndex,
      profileId: profile.id,
      greenBeanId: profile.greenBeanId,
      chargeG: profile.chargeG,
      state,
      operatorName,
      createdAt: stamp,
      updatedAt: stamp,
    };
    pots.push(pot);
    toAdd.push(pot);
    havePot.add(profile.id);
  }
  return toAdd;
}

/** 为单条记录补一口锅（历史数据兜底用） */
async function addPotForProfile(
  profile: RoastProfile,
  state: PotState,
  stamp: string,
): Promise<SchedulePot> {
  const capacities = await db.machineCapacity.toArray();
  const limit = potLimitFor(profile.machineModel, capacities);
  const slot = findEarliestSlot(await db.schedulePots.toArray(), profile.machineModel, profile.roastedAt, limit);
  const pot: SchedulePot = {
    id: createId('pot'),
    machineModel: profile.machineModel,
    scheduledDate: slot?.date ?? profile.roastedAt,
    potIndex: slot?.potIndex ?? 1,
    profileId: profile.id,
    greenBeanId: profile.greenBeanId,
    chargeG: profile.chargeG,
    state,
    operatorName: DEFAULT_OPERATOR_NAME,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.schedulePots.put(pot);
  return pot;
}

/* --------------------------- 机型日锅次上限 MachineCapacity --------------------------- */

export async function listMachineCapacities(): Promise<MachineCapacity[]> {
  const rows = await db.machineCapacity.toArray();
  return rows.sort((a, b) => a.model.localeCompare(b.model, 'zh-Hans-CN'));
}

export async function putMachineCapacity(model: string, dailyPotLimit: number): Promise<MachineCapacity[]> {
  const stamp = nowIso();
  const existing = await db.machineCapacity.get(model);
  await db.machineCapacity.put({
    model,
    dailyPotLimit,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  });
  return listMachineCapacities();
}

/* ------------------------------ 锅次占用账 SchedulePot ------------------------------ */

export async function listSchedulePots(): Promise<SchedulePot[]> {
  return db.schedulePots.toArray();
}

export interface ClaimScheduleInput {
  /** 新建或更新后的烘焙记录 */
  profile: RoastProfile;
  operatorName: string;
  /** create：直接占锅；update：先释放旧锅再重新占锅 */
  mode: 'create' | 'update';
}

export interface ClaimScheduleResult {
  ok: boolean;
  message: string;
  profile?: RoastProfile;
  pot?: SchedulePot;
  /** 是否因当天锅次排满而顺延到了次日 */
  rolledOver: boolean;
  /** 抢占失败的锅次（晚到的一单看到被谁占了） */
  collisions: Array<{ date: string; potIndex: number; operatorName: string; profileId: string }>;
  availableKg?: number;
}

/**
 * 原子排产：在一个事务里完成「校验生豆可用余量 → 顺延找空锅 → 原子占锅 → 写烘焙记录」。
 * 占锅用复合主键 + add（冲突抛 ConstraintEror）+ 事务内重读，
 * 两人同时提交同一机型同一天同一锅次时，只有一单能占上，晚到的一单会看到被谁占了。
 */
export async function claimScheduleSlot(input: ClaimScheduleInput): Promise<ClaimScheduleResult> {
  const { profile, operatorName, mode } = input;
  return db.transaction(
    'rw',
    [db.schedulePots, db.greenBeans, db.roastProfiles, db.machineCapacity],
    async () => {
      const stamp = nowIso();
      const bean = await db.greenBeans.get(profile.greenBeanId);
      if (!bean) {
        return { ok: false, message: '该烘焙记录关联的生豆已不存在', rolledOver: false, collisions: [] };
      }

      const [allPots, capacities] = await Promise.all([
        db.schedulePots.toArray(),
        db.machineCapacity.toArray(),
      ]);
      const limit = potLimitFor(profile.machineModel, capacities);

      // 编辑场景：先释放该记录的旧锅（仅「预留中」才移动；已扣减的不动锅，只调载量差额）
      let pots = allPots;
      if (mode === 'update') {
        const old = allPots.find((pot) => pot.profileId === profile.id);
        if (old && old.state === 'reserved') {
          await db.schedulePots.delete([old.machineModel, old.scheduledDate, old.potIndex]);
          pots = allPots.filter((pot) => pot !== old);
        } else if (old && old.state === 'consumed') {
          const deltaKg = roundKg((profile.chargeG - old.chargeG) / 1000);
          if (deltaKg !== 0) {
            if (bean.stockKg + 1e-6 < deltaKg) {
              return {
                ok: false,
                message: `载量调高后生豆余量不足：在库 ${bean.stockKg}kg，还需 ${deltaKg}kg，请先补货或下调载量`,
                rolledOver: false,
                collisions: [],
                availableKg: bean.stockKg,
              };
            }
            bean.stockKg = roundKg(bean.stockKg - deltaKg);
            bean.updatedAt = stamp;
            await db.greenBeans.put(bean);
          }
          const updatedPot: SchedulePot = {
            ...old,
            chargeG: profile.chargeG,
            greenBeanId: profile.greenBeanId,
            updatedAt: stamp,
          };
          await db.schedulePots.put(updatedPot);
          await db.roastProfiles.put(profile);
          return {
            ok: true,
            message: '烘焙记录已更新（已扣减锅次仅调整载量差额，锅次不变）',
            profile,
            pot: updatedPot,
            rolledOver: false,
            collisions: [],
            availableKg: bean.stockKg,
          };
        }
      }

      // 可用余量校验：在库 − 其它锅次预留中（编辑时旧锅已删，自然排除自身）
      const reservedOthers = reservedKgOfBean(bean.id, pots, profile.id);
      const availableKg = roundKg(bean.stockKg - reservedOthers);
      const needKg = roundKg(profile.chargeG / 1000);
      if (availableKg + 1e-6 < needKg) {
        return {
          ok: false,
          message: `生豆可用余量不足：在库 ${bean.stockKg}kg，已预留 ${reservedOthers}kg，可用 ${availableKg}kg < 本锅 ${needKg}kg，请补货、下调载量或改期`,
          rolledOver: false,
          collisions: [],
          availableKg,
        };
      }

      // 顺延找空锅，逐锅原子抢占
      const collisions: ClaimScheduleResult['collisions'] = [];
      const takenByDay = new Map<string, Set<number>>();
      const isTaken = (date: string, potIndex: number): boolean => {
        let set = takenByDay.get(date);
        if (!set) {
          set = occupiedPotSet(pots, profile.machineModel, date);
          takenByDay.set(date, set);
        }
        return set.has(potIndex);
      };
      const markTaken = (date: string, potIndex: number): void => {
        let set = takenByDay.get(date);
        if (!set) {
          set = occupiedPotSet(pots, profile.machineModel, date);
          takenByDay.set(date, set);
        }
        set.add(potIndex);
      };

      let assigned: SlotRef | null = null;
      let addedPot: SchedulePot | null = null;
      const potId = createId('pot');

      // 从请求日起，一天一天向后找空锅
      scheduleLoop: for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_DAYS; offset += 1) {
        const date = addDays(profile.roastedAt, offset);
        for (let potIndex = 1; potIndex <= limit; potIndex += 1) {
          if (isTaken(date, potIndex)) continue;
          // 事务内重读，赢下并发：若已被别的单占，记下抢占者并让开
          const existing = await db.schedulePots.get([profile.machineModel, date, potIndex]);
          if (existing && existing.state !== 'void' && existing.profileId !== profile.id) {
            collisions.push({
              date,
              potIndex,
              operatorName: existing.operatorName,
              profileId: existing.profileId,
            });
            markTaken(date, potIndex);
            continue;
          }
          const pot: SchedulePot = {
            id: potId,
            machineModel: profile.machineModel,
            scheduledDate: date,
            potIndex,
            profileId: profile.id,
            greenBeanId: profile.greenBeanId,
            chargeG: profile.chargeG,
            state: 'reserved',
            operatorName,
            createdAt: stamp,
            updatedAt: stamp,
          };
          try {
            await db.schedulePots.add(pot);
          } catch (err) {
            // 复合主键冲突：被并发的另一单抢先占了这锅
            const winner = await db.schedulePots.get([profile.machineModel, date, potIndex]);
            if (winner && winner.state !== 'void' && winner.profileId !== profile.id) {
              collisions.push({
                date,
                potIndex,
                operatorName: winner.operatorName,
                profileId: winner.profileId,
              });
              markTaken(date, potIndex);
              continue;
            }
            throw err;
          }
          assigned = { date, potIndex };
          addedPot = pot;
          break scheduleLoop;
        }
      }

      if (!assigned || !addedPot) {
        return {
          ok: false,
          message: `该机型未来 ${MAX_SCHEDULE_LOOKAHEAD_DAYS} 天锅次全满，无法排产`,
          rolledOver: false,
          collisions,
          availableKg,
        };
      }

      await db.roastProfiles.put(profile);
      const rolledOver = assigned.date > profile.roastedAt;
      const firstCollision = collisions[0];
      const message = firstCollision
        ? `原计划 ${firstCollision.date} 第 ${firstCollision.potIndex} 锅被「${firstCollision.operatorName}」占了，已顺延至 ${assigned.date} 第 ${assigned.potIndex} 锅`
        : rolledOver
          ? `当天锅次已排满，已顺延至 ${assigned.date} 第 ${assigned.potIndex} 锅`
          : `已排 ${assigned.date} 第 ${assigned.potIndex} 锅（预留 ${needKg}kg）`;
      return {
        ok: true,
        message,
        profile,
        pot: addedPot,
        rolledOver,
        collisions,
        availableKg,
      };
    },
  );
}

export interface TransitionResult {
  ok: boolean;
  message: string;
  profile?: RoastProfile;
  pot?: SchedulePot;
  deductedKg?: number;
  remainingKg?: number;
  warning?: boolean;
  availableKg?: number;
}

/**
 * 烘焙记录状态流转 + 锅次/库存联动（一个事务）：
 * - done：预留转实际扣减（在库重量减少），锅次 reserved→consumed；
 * - void：作废把预留还回生豆（已扣减的加回在库），锅次→void；
 * - recording（从 void 恢复）：重新校验可用余量并占锅。
 */
export async function transitionRoastState(
  profileId: string,
  next: RoastState,
): Promise<TransitionResult> {
  return db.transaction(
    'rw',
    [db.schedulePots, db.greenBeans, db.roastProfiles, db.machineCapacity],
    async () => {
      const stamp = nowIso();
      const profile = await db.roastProfiles.get(profileId);
      if (!profile) return { ok: false, message: '烘焙记录不存在' };
      const bean = await db.greenBeans.get(profile.greenBeanId);
      const pot = await db.schedulePots.where('profileId').equals(profileId).first();

      if (next === 'done') {
        if (profile.state === 'done') {
          return { ok: false, message: '该记录已是「已完成」，无需重复扣减', profile, pot: pot ?? undefined };
        }
        if (profile.state !== 'recording') {
          return {
            ok: false,
            message: `「${ROAST_STATE_LABEL[profile.state]}」不能直接标记完成，请先恢复为「记录中」`,
            profile,
            pot: pot ?? undefined,
          };
        }
        if (!bean) return { ok: false, message: '该记录关联的生豆已不存在', profile, pot: pot ?? undefined };
        const deductedKg = roundKg(profile.chargeG / 1000);
        if (bean.stockKg + 1e-6 < deductedKg) {
          return {
            ok: false,
            message: `生豆余量不足：在库 ${bean.stockKg}kg < 本锅 ${deductedKg}kg，请先补货或下调载量`,
            profile,
            pot: pot ?? undefined,
            warning: true,
          };
        }
        const remainingKg = roundKg(bean.stockKg - deductedKg);
        const nextBean: GreenBean = { ...bean, stockKg: remainingKg, updatedAt: stamp };
        const nextProfile: RoastProfile = { ...profile, state: 'done', updatedAt: stamp };
        await db.greenBeans.put(nextBean);
        await db.roastProfiles.put(nextProfile);
        let nextPot: SchedulePot | undefined = pot ?? undefined;
        if (pot && pot.state === 'reserved') {
          nextPot = {
            ...pot,
            state: 'consumed',
            chargeG: profile.chargeG,
            greenBeanId: profile.greenBeanId,
            updatedAt: stamp,
          };
          await db.schedulePots.put(nextPot);
        } else if (!pot) {
          nextPot = await addPotForProfile(nextProfile, 'consumed', stamp);
        }
        const warning = remainingKg < LOW_STOCK_KG;
        return {
          ok: true,
          message: `已按载量扣减 ${deductedKg}kg，${bean.farm || bean.origin} 余量 ${remainingKg}kg${
            warning ? '（余量偏低，请及时补货）' : ''
          }`,
          profile: nextProfile,
          pot: nextPot,
          deductedKg,
          remainingKg,
          warning,
        };
      }

      if (next === 'void') {
        if (profile.state === 'void') {
          return { ok: false, message: '该记录已是「作废」', profile, pot: pot ?? undefined };
        }
        let nextPot: SchedulePot | undefined = pot ?? undefined;
        let refundKg = 0;
        if (pot && pot.state === 'consumed') {
          // 已扣减的锅作废：把豆子加回在库
          if (bean) {
            refundKg = roundKg(pot.chargeG / 1000);
            await db.greenBeans.put({
              ...bean,
              stockKg: roundKg(bean.stockKg + refundKg),
              updatedAt: stamp,
            });
          }
          nextPot = { ...pot, state: 'void', updatedAt: stamp };
          await db.schedulePots.put(nextPot);
        } else if (pot && pot.state === 'reserved') {
          nextPot = { ...pot, state: 'void', updatedAt: stamp };
          await db.schedulePots.put(nextPot);
        }
        const nextProfile: RoastProfile = { ...profile, state: 'void', updatedAt: stamp };
        await db.roastProfiles.put(nextProfile);
        return {
          ok: true,
          message:
            refundKg > 0
              ? `已作废并回退 ${refundKg}kg 到生豆在库，预留锅次已释放`
              : '已作废，预留锅次已释放（可用余量已恢复）',
          profile: nextProfile,
          pot: nextPot,
        };
      }

      if (next === 'recording') {
        if (profile.state !== 'void') {
          return { ok: false, message: '只有「作废」的记录可恢复为「记录中」', profile, pot: pot ?? undefined };
        }
        if (!bean) return { ok: false, message: '该记录关联的生豆已不存在', profile, pot: pot ?? undefined };
        const capacities = await db.machineCapacity.toArray();
        const reservedOthers = reservedKgOfBean(bean.id, await db.schedulePots.toArray(), profile.id);
        const availableKg = roundKg(bean.stockKg - reservedOthers);
        const needKg = roundKg(profile.chargeG / 1000);
        if (availableKg + 1e-6 < needKg) {
          return {
            ok: false,
            message: `恢复失败：生豆可用余量不足（可用 ${availableKg}kg < 本锅 ${needKg}kg）`,
            profile,
            pot: pot ?? undefined,
            availableKg,
          };
        }
        // 释放旧的作废锅，重新找空锅占上
        if (pot) await db.schedulePots.delete([pot.machineModel, pot.scheduledDate, pot.potIndex]);
        const limit = potLimitFor(profile.machineModel, capacities);
        const slot = findEarliestSlot(
          await db.schedulePots.toArray(),
          profile.machineModel,
          profile.roastedAt,
          limit,
        );
        if (!slot) {
          return {
            ok: false,
            message: `恢复失败：该机型未来 ${MAX_SCHEDULE_LOOKAHEAD_DAYS} 天锅次全满`,
            profile,
            pot: pot ?? undefined,
          };
        }
        const newPot: SchedulePot = {
          id: createId('pot'),
          machineModel: profile.machineModel,
          scheduledDate: slot.date,
          potIndex: slot.potIndex,
          profileId: profile.id,
          greenBeanId: profile.greenBeanId,
          chargeG: profile.chargeG,
          state: 'reserved',
          operatorName: pot?.operatorName ?? DEFAULT_OPERATOR_NAME,
          createdAt: stamp,
          updatedAt: stamp,
        };
        await db.schedulePots.add(newPot);
        const nextProfile: RoastProfile = { ...profile, state: 'recording', updatedAt: stamp };
        await db.roastProfiles.put(nextProfile);
        return {
          ok: true,
          message:
            slot.date > profile.roastedAt
              ? `已恢复记录，顺延至 ${slot.date} 第 ${slot.potIndex} 锅`
              : `已恢复记录，排 ${slot.date} 第 ${slot.potIndex} 锅（预留 ${needKg}kg）`,
          profile: nextProfile,
          pot: newPot,
        };
      }

      return { ok: false, message: '未知状态流转', profile, pot: pot ?? undefined };
    },
  );
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

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测与锅次账，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.schedulePots],
    async () => {
      const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
      const profileIds = profiles.map((profile) => profile.id);
      if (profileIds.length > 0) {
        await db.events.where('profileId').anyOf(profileIds).delete();
        await db.cuppings.where('profileId').anyOf(profileIds).delete();
        await db.schedulePots.where('profileId').anyOf(profileIds).delete();
        await db.roastProfiles.bulkDelete(profileIds);
      }
      await db.schedulePots.where('greenBeanId').equals(id).delete();
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

/** 删除烘焙记录：级联删除曲线事件、杯测与锅次账，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction('rw', [db.roastProfiles, db.events, db.cuppings, db.blends, db.schedulePots], async () => {
    await db.events.where('profileId').equals(id).delete();
    await db.cuppings.where('profileId').equals(id).delete();
    await db.schedulePots.where('profileId').equals(id).delete();
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
 */
export async function consumeStockForProfile(profileId: string): Promise<StockConsumeResult> {
  return db.transaction('rw', [db.greenBeans, db.roastProfiles, db.schedulePots, db.machineCapacity], async () => {
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

    // 预留锅次转成实际扣减（没有锅账的历史记录补一口已扣减锅）
    const pot = await db.schedulePots.where('profileId').equals(profile.id).first();
    if (pot && pot.state === 'reserved') {
      await db.schedulePots.put({
        ...pot,
        state: 'consumed',
        chargeG: profile.chargeG,
        greenBeanId: profile.greenBeanId,
        updatedAt: stamp,
      });
    } else if (!pot) {
      await addPotForProfile(nextProfile, 'consumed', stamp);
    }

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
  machineCapacity: MachineCapacity[];
  schedulePots: SchedulePot[];
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
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, machineCapacity, schedulePots] =
    await Promise.all([
      db.greenBeans.toArray(),
      db.roastProfiles.toArray(),
      db.events.toArray(),
      db.cuppings.toArray(),
      db.blends.toArray(),
      db.machineTemplates.toArray(),
      db.machineCapacity.toArray(),
      db.schedulePots.toArray(),
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
    machineCapacity,
    schedulePots,
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
      db.machineCapacity,
      db.schedulePots,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.machineCapacity.clear(),
        db.schedulePots.clear(),
      ]);
      await db.greenBeans.bulkPut(snapshot.greenBeans);
      await db.roastProfiles.bulkPut(snapshot.roastProfiles);
      await db.events.bulkPut(snapshot.events);
      await db.cuppings.bulkPut(snapshot.cuppings);
      await db.blends.bulkPut(snapshot.blends);
      await db.machineTemplates.bulkPut(snapshot.machineTemplates ?? []);
      await db.machineCapacity.bulkPut(snapshot.machineCapacity ?? []);
      await db.schedulePots.bulkPut(snapshot.schedulePots ?? []);
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
      db.machineCapacity,
      db.schedulePots,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.machineCapacity.clear(),
        db.schedulePots.clear(),
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
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, machineCapacity, schedulePots] =
    await Promise.all([
      db.greenBeans.count(),
      db.roastProfiles.count(),
      db.events.count(),
      db.cuppings.count(),
      db.blends.count(),
      db.machineTemplates.count(),
      db.machineCapacity.count(),
      db.schedulePots.count(),
    ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, machineCapacity, schedulePots };
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
  const day = (offset: number): string => {
    const base = new Date('2025-01-10T08:00:00.000Z');
    base.setUTCDate(base.getUTCDate() + offset);
    return base.toISOString().slice(0, 10);
  };

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

  // 机型日锅次上限（按机型配置）
  const machineCapacity: MachineCapacity[] = [
    { model: 'HB-M6', dailyPotLimit: 4, createdAt: stamp, updatedAt: stamp },
    { model: 'Giesen W6A', dailyPotLimit: 3, createdAt: stamp, updatedAt: stamp },
    { model: 'Probat P12', dailyPotLimit: 2, createdAt: stamp, updatedAt: stamp },
    { model: 'Mill City 500g', dailyPotLimit: 6, createdAt: stamp, updatedAt: stamp },
  ];

  // 锅次占用账：按烘焙日期依次占锅，状态随记录（已完成→已扣减 / 记录中→预留中 / 作废→已作废）
  const schedulePots = buildSchedulePotsForProfiles(
    roastProfiles,
    [],
    machineCapacity,
    stamp,
    DEFAULT_OPERATOR_NAME,
  );

  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.machineCapacity,
      db.schedulePots,
    ],
    async () => {
      await db.greenBeans.bulkPut(greenBeans);
      await db.roastProfiles.bulkPut(roastProfiles);
      await db.events.bulkPut(events);
      await db.cuppings.bulkPut(cuppings);
      await db.blends.bulkPut(blends);
      await db.machineTemplates.bulkPut(machineTemplates);
      await db.machineCapacity.bulkPut(machineCapacity);
      await db.schedulePots.bulkPut(schedulePots);
    },
  );
}
