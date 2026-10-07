/**
 * 排产台账 · 机型日锅次上限 + 锅次占用账
 *
 * 一笔烘焙记录（锅）在「记录中」时会：
 *   1. 按载量从生豆可用余量里预留（encumber）一锅 —— 豆子还在库里，但已被这锅定下；
 *   2. 占用该机型排产日的一个锅次（当天锅次有上限，排满顺延次日）。
 * 状态流转：
 *   - 作废（void）：预留还回生豆、锅次释放；
 *   - 下豆完成（done）：预留转成实际扣减（在库重量减少）；
 *   - 载量 / 机型 / 日期 / 生豆改动：预留克重与锅次占用立即重算。
 * 全部落 IndexedDB，刷新或重开浏览器账都还在。
 */

export type PotState = 'reserved' | 'consumed' | 'void';

/** 机型每日可排锅次上限（按机型号配置，/machines 维护） */
export interface MachineCapacity {
  /** 机型号（主键） */
  model: string;
  /** 当天锅次上限（锅/天） */
  dailyPotLimit: number;
  createdAt: string;
  updatedAt: string;
}

/** 一条锅次占用账（复合主键 [machineModel+scheduledDate+potIndex] 保证同机型同天同锅次唯一） */
export interface SchedulePot {
  id: string;
  /** 机型号 */
  machineModel: string;
  /** 实际排产日期（YYYY-MM-DD）；当天排满会顺延到次日 */
  scheduledDate: string;
  /** 当天第几锅（1 起） */
  potIndex: number;
  /** 关联烘焙记录 */
  profileId: string;
  /** 预留的生豆批次 */
  greenBeanId: string;
  /** 预留载量（克） */
  chargeG: number;
  /** 锅次状态：预留中 / 已扣减 / 已作废 */
  state: PotState;
  /** 排产人 —— 晚到的一单看到这锅被谁占了 */
  operatorName: string;
  createdAt: string;
  updatedAt: string;
}

export const POT_STATE_LABEL: Record<PotState, string> = {
  reserved: '预留中',
  consumed: '已扣减',
  void: '已作废',
};

export const POT_STATE_COLOR: Record<PotState, string> = {
  reserved: '#c9963c',
  consumed: '#2f6f4f',
  void: '#b3372f',
};

export const POT_STATE_ORDER: PotState[] = ['reserved', 'consumed', 'void'];

/** 未单独配置机型日锅次上限时的默认值（锅/天） */
export const DEFAULT_DAILY_POT_LIMIT = 4;

/** 顺延查找的最大天数（从请求日起向后找空锅） */
export const MAX_SCHEDULE_LOOKAHEAD_DAYS = 30;

/** 排产人本地存储键与默认名（单机应用，用本地称呼模拟「谁占了这锅」） */
export const OPERATOR_NAME_STORAGE_KEY = 'gbroastlog.operatorName';
export const DEFAULT_OPERATOR_NAME = '当班烘焙师';
