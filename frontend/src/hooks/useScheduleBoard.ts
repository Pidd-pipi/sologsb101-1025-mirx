/**
 * useScheduleBoard：排产账本派生数据（纯前端实时重算，源数据来自 liveQuery 订阅）。
 * - 每台机器在查看日的锅次占用（已排/已下豆/上限/剩余/是否排满）。
 * - 每批生豆的在库 / 已预留 / 可用余量（改载量、作废、下豆都会即时变化）。
 * - 未排进锅次的「记录中」烘焙记录（补排候选）。
 */
import { useMemo } from 'react';
import type { GreenBean } from '../types/greenbean';
import type { RoastProfile } from '../types/roastprofile';
import type { BatchBooking, BookingState, RoasterMachine } from '../types/schedule';
import {
  availableKg,
  gToKg,
  isOccupying,
  occupiedCount,
  occupiedSlotKeys,
  reservedKgByBean,
} from '../utils/schedule';

export interface MachineDayUsage {
  machine: RoasterMachine;
  booked: number;
  dropped: number;
  occupied: number;
  limit: number;
  remaining: number;
  full: boolean;
}

export interface BeanLedger {
  bean: GreenBean;
  stockKg: number;
  reservedKg: number;
  availableKg: number;
  /** 预留超过在库（一般是在库被直接改小） */
  overReserved: boolean;
}

export interface ScheduleBoard {
  machineUsage: MachineDayUsage[];
  machineUsageById: Map<string, MachineDayUsage>;
  beanLedgers: BeanLedger[];
  beanLedgerById: Map<string, BeanLedger>;
  reservedByBean: Map<string, number>;
  dayBookings: BatchBooking[];
  takenSlotKeys: Set<string>;
  /** 未排进任何占用中锅次的「记录中」烘焙记录 */
  unscheduledProfiles: RoastProfile[];
  /** 当天已排产预留总量（kg） */
  totalReservedKg: number;
}

export function useScheduleBoard(
  machines: RoasterMachine[],
  bookings: BatchBooking[],
  beans: GreenBean[],
  profiles: RoastProfile[],
  viewDate: string,
): ScheduleBoard {
  return useMemo(() => {
    const dayBookings = bookings.filter((booking) => booking.planDate === viewDate);

    const machineUsage: MachineDayUsage[] = machines.map((machine) => {
      const inDay = dayBookings.filter((booking) => booking.machineId === machine.id);
      const booked = inDay.filter((booking) => booking.state === 'booked').length;
      const dropped = inDay.filter((booking) => booking.state === 'dropped').length;
      const occupied = occupiedCount(bookings, machine.id, viewDate);
      const limit = machine.dailyLimit;
      return {
        machine,
        booked,
        dropped,
        occupied,
        limit,
        remaining: Math.max(0, limit - occupied),
        full: occupied >= limit,
      };
    });
    const machineUsageById = new Map(machineUsage.map((usage) => [usage.machine.id, usage]));

    const reservedByBean = reservedKgByBean(bookings);
    const beanLedgers: BeanLedger[] = beans.map((bean) => {
      const reservedKg = reservedByBean.get(bean.id) ?? 0;
      const available = availableKg(bookings, bean.stockKg, bean.id);
      return {
        bean,
        stockKg: bean.stockKg,
        reservedKg,
        availableKg: available,
        overReserved: available < -1e-6,
      };
    });
    const beanLedgerById = new Map(beanLedgers.map((ledger) => [ledger.bean.id, ledger]));

    const scheduledProfileIds = new Set(
      bookings
        .filter((booking) => isOccupying(booking.state) && booking.profileId)
        .map((booking) => booking.profileId as string),
    );
    const unscheduledProfiles = profiles.filter(
      (profile) => profile.state === 'recording' && !scheduledProfileIds.has(profile.id),
    );

    const totalReservedKg = Math.round(
      bookings
        .filter((booking) => booking.state === ('booked' satisfies BookingState))
        .reduce((acc, booking) => acc + gToKg(booking.chargeG), 0) * 1000,
    ) / 1000;

    return {
      machineUsage,
      machineUsageById,
      beanLedgers,
      beanLedgerById,
      reservedByBean,
      dayBookings,
      takenSlotKeys: occupiedSlotKeys(dayBookings),
      unscheduledProfiles,
      totalReservedKg,
    };
  }, [machines, bookings, beans, profiles, viewDate]);
}
