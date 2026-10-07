/**
 * 排产账本纯函数：锅次上限占用、生豆预留（派生）、可用余量、时段候选。
 * 不碰数据库，db.ts 的事务与页面/hooks 共用同一套计算口径。
 */
import {
  DEFAULT_SLOT_MINUTES,
  formatHHmm,
  makeSlotKey,
  parseHHmm,
  RESERVING_STATES,
  OCCUPYING_STATES,
  type BatchBooking,
  type BookingState,
  type RoasterMachine,
} from '../types/schedule';

/** 克 → 千克（保留三位小数） */
export function gToKg(chargeG: number): number {
  return Math.round((chargeG / 1000) * 1000) / 1000;
}

/** 某锅次是否仍占用当天锅次（已排产 / 已下豆） */
export function isOccupying(state: BookingState): boolean {
  return OCCUPYING_STATES.includes(state);
}

/** 某锅次是否仍预留生豆（已排产） */
export function isReserving(state: BookingState): boolean {
  return RESERVING_STATES.includes(state);
}

/** 某机器某天已占用锅次数（已排产 + 已下豆，作废不计） */
export function occupiedCount(bookings: BatchBooking[], machineId: string, planDate: string): number {
  return bookings.filter(
    (booking) =>
      booking.machineId === machineId && booking.planDate === planDate && isOccupying(booking.state),
  ).length;
}

/** 当天是否已排满 */
export function isDayFull(
  bookings: BatchBooking[],
  machine: RoasterMachine,
  planDate: string,
): boolean {
  return occupiedCount(bookings, machine.id, planDate) >= machine.dailyLimit;
}

/** 生豆被各「已排产」锅次预留的总量（kg，派生值：随载量/状态即时重算） */
export function reservedKgForBean(bookings: BatchBooking[], greenBeanId: string): number {
  const total = bookings
    .filter((booking) => booking.greenBeanId === greenBeanId && isReserving(booking.state))
    .reduce((acc, booking) => acc + gToKg(booking.chargeG), 0);
  return Math.round(total * 1000) / 1000;
}

/** 每批生豆的预留量映射 */
export function reservedKgByBean(bookings: BatchBooking[]): Map<string, number> {
  const map = new Map<string, number>();
  bookings.forEach((booking) => {
    if (!isReserving(booking.state)) return;
    map.set(
      booking.greenBeanId,
      Math.round(((map.get(booking.greenBeanId) ?? 0) + gToKg(booking.chargeG)) * 1000) / 1000,
    );
  });
  return map;
}

/** 可用余量 = 在库 - 其它已排产预留（kg）；excludeBookingId 用于改载量时排除自身 */
export function availableKg(
  bookings: BatchBooking[],
  stockKg: number,
  greenBeanId: string,
  excludeBookingId?: string,
): number {
  const reserved = bookings
    .filter(
      (booking) =>
        booking.greenBeanId === greenBeanId &&
        isReserving(booking.state) &&
        booking.id !== excludeBookingId,
    )
    .reduce((acc, booking) => acc + gToKg(booking.chargeG), 0);
  return Math.round((stockKg - reserved) * 1000) / 1000;
}

/** 已被占用的时段键集合（booked / dropped） */
export function occupiedSlotKeys(bookings: BatchBooking[]): Set<string> {
  const keys = new Set<string>();
  bookings.forEach((booking) => {
    if (isOccupying(booking.state) && booking.slotKey) keys.add(booking.slotKey);
  });
  return keys;
}

/**
 * 列出机器某天可排时段（按 slotMinutes 切分营业时间），并标记每个时段是否已占。
 */
export function listSlotOptions(
  machine: RoasterMachine,
  bookings: BatchBooking[],
  planDate: string,
): Array<{ slotAt: string; occupied: boolean; occupant?: BatchBooking }> {
  const start = parseHHmm(machine.openFrom);
  const end = parseHHmm(machine.openTo);
  if (start === null || end === null || end <= start) return [];
  const byKey = new Map<string, BatchBooking>();
  bookings.forEach((booking) => {
    if (isOccupying(booking.state) && booking.slotKey) byKey.set(booking.slotKey, booking);
  });
  const step = machine.slotMinutes > 0 ? machine.slotMinutes : DEFAULT_SLOT_MINUTES;
  const options: Array<{ slotAt: string; occupied: boolean; occupant?: BatchBooking }> = [];
  for (let minute = start; minute < end; minute += step) {
    const slotAt = formatHHmm(minute);
    const key = makeSlotKey(machine.id, planDate, slotAt);
    const occupant = byKey.get(key);
    options.push({ slotAt, occupied: Boolean(occupant), occupant });
  }
  return options;
}

/** 校验 HH:mm 合法性 */
export function isValidHHmm(value: string): boolean {
  return parseHHmm(value) !== null;
}

/** 在本地时区给日期字符串加 n 天，返回 YYYY-MM-DD（避免 toISOString 的 UTC 偏移问题） */
export function addDaysLocal(dateText: string, days: number): string {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 今天的本地日期 YYYY-MM-DD */
export function todayLocal(): string {
  return addDaysLocal(
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
      new Date().getDate(),
    ).padStart(2, '0')}`,
    0,
  );
}
