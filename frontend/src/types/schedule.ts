/**
 * 排产账本：烘焙机（按机型记当天锅次上限）+ 锅次占用单（时段互斥 / 生豆预留）。
 *
 * 记账规则（与 src/utils/db.ts 的事务实现一一对应）：
 * 1. 每台烘焙机按机型配置 dailyLimit「当天锅次上限」，当天已排 + 已下豆锅次排满即不再接锅，多出的顺延次日。
 * 2. 建锅次占用单（= 建烘焙记录）时按载量 chargeG 从生豆「可用余量」（在库 - 其它已排预留）中留出这一锅。
 * 3. 同一台机器同一天同一时段只有一单能成功：slotKey = machineId|planDate|slotAt，Dexie 唯一索引兜底
 *    （两个浏览器标签页同时提交也只会成功一单），晚到的一单会收到「被谁占了」的占用者信息。
 * 4. 作废（booked → void）：释放时段占用并把预留还回生豆（预留为派生值，状态一改即重算）。
 * 5. 下豆完成（booked → dropped）：预留转成实际扣减，按载量扣减在库重量；时段仍留在账上（该锅确已开过）。
 * 6. 载量一改动，预留（按 chargeG 求和）与占用提示立刻重算；所有数据持久化在 IndexedDB，重开页面还在。
 */

/** 锅次状态：已排产（占用时段 + 预留生豆）/ 已下豆（实际扣减）/ 已作废（释放时段与预留） */
export type BookingState = 'booked' | 'dropped' | 'void';

/** 烘焙机：按机型登记当天锅次上限与时段切分方式 */
export interface RoasterMachine {
  id: string;
  /** 机型号（与烘焙记录 machineModel 对应） */
  model: string;
  /** 当天锅次上限：当天已排产 + 已下豆锅次数达到此值就不再接锅 */
  dailyLimit: number;
  /** 时段粒度（分钟）：按此粒度把营业时间切成可选时段 */
  slotMinutes: number;
  /** 开烘时间（HH:mm） */
  openFrom: string;
  /** 收烘时间（HH:mm） */
  openTo: string;
  /** 备注 */
  note: string;
  /** 是否启用（停用后不再出现在排产选项里，历史账本保留） */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 锅次占用单（排产账本主体） */
export interface BatchBooking {
  id: string;
  /** 烘焙机 id（机器删除受账本保护，历史单始终可追溯） */
  machineId: string;
  /** 机型号冗余：列表展示无需回查机器表 */
  machineModel: string;
  /** 生豆 id：预留的对象 */
  greenBeanId: string;
  /** 关联烘焙记录 id：排产同时建烘焙记录；历史曲线/杯测挂在它下面 */
  profileId?: string;
  /** 计划日期（YYYY-MM-DD）；当天排满顺延时会被改成次日日期 */
  planDate: string;
  /** 计划时段（HH:mm，按机器 slotMinutes 对齐） */
  slotAt: string;
  /** 载量（克）：预留与下豆实际扣减都按它计算；改动即重算预留 */
  chargeG: number;
  /** 排单烘焙师：占用成功的人是谁（晚到的一单据此看到被谁占了） */
  operator: string;
  /** 锅次状态 */
  state: BookingState;
  /** 备注（如豆款、特殊火力要求） */
  note: string;
  /**
   * 时段占用键 machineId|planDate|slotAt，Dexie 唯一索引。
   * 仅 booked / dropped 持有；void 时删除该字段（释放时段，且不占唯一索引坑位）。
   */
  slotKey?: string;
  /** 是否因当天锅次已满被顺延到次日（或更后） */
  deferred: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 新建排产单的表单草稿 */
export type BatchBookingDraft = Omit<
  BatchBooking,
  'id' | 'machineModel' | 'state' | 'slotKey' | 'deferred' | 'createdAt' | 'updatedAt'
>;

export type RoasterMachineDraft = Omit<RoasterMachine, 'id' | 'createdAt' | 'updatedAt'>;

export const BOOKING_STATE_LABEL: Record<BookingState, string> = {
  booked: '已排产',
  dropped: '已下豆',
  void: '已作废',
};

export const BOOKING_STATE_COLOR: Record<BookingState, string> = {
  booked: '#c9963c',
  dropped: '#2f6f4f',
  void: '#b3372f',
};

export const BOOKING_STATE_ORDER: BookingState[] = ['booked', 'dropped', 'void'];

export const BOOKING_STATE_OPTIONS = BOOKING_STATE_ORDER.map((value) => ({
  value,
  label: BOOKING_STATE_LABEL[value],
}));

/** 占用锅次（计入当天锅次上限）：已排产与已下豆；作废不占锅 */
export const OCCUPYING_STATES: BookingState[] = ['booked', 'dropped'];

/** 仍预留生豆的状态：只有已排产；已下豆转实际扣减、已作废归还 */
export const RESERVING_STATES: BookingState[] = ['booked'];

export const DEFAULT_SLOT_MINUTES = 30;
export const MIN_SLOT_MINUTES = 10;
export const MAX_SLOT_MINUTES = 120;
export const MIN_DAILY_LIMIT = 1;
export const MAX_DAILY_LIMIT = 60;

/** 时段占用键：同机同日同时段全局唯一 */
export function makeSlotKey(machineId: string, planDate: string, slotAt: string): string {
  return `${machineId}|${planDate}|${slotAt}`;
}

/** HH:mm → 当日分钟数；非法时间返回 null */
export function parseHHmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 当日分钟数 → HH:mm */
export function formatHHmm(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
