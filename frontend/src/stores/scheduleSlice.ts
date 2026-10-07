/**
 * 排产 slice：烘焙机（当天锅次上限）与锅次占用单的增删改 + 锅次动作（提交 / 下豆 / 作废 / 恢复 / 改载量）。
 * 列表本体用 useIdbTable 的 liveQuery 跨标签页订阅（两人同时操作同一库实时可见）；
 * 这里保留 filters / operator（排单烘焙师）/ 当前查看日期等跨页状态。
 */
import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  BatchBooking,
  BookingState,
  RoasterMachine,
  RoasterMachineDraft,
} from '../types/schedule';
import {
  changeBookingCharge,
  createId,
  dropBooking,
  listBatchBookings,
  listRoasterMachines,
  nowIso,
  putRoasterMachine,
  removeRoasterMachine,
  restoreBooking,
  submitBatchBooking,
  type SubmitBookingInput,
  type SubmitBookingResult,
  voidBooking,
} from '../utils/db';
import type { RootState } from './store';

export interface ScheduleFilters {
  keyword: string;
  machineIds: string[];
  states: BookingState[];
  /** 只看顺延锅次 */
  deferredOnly: boolean;
}

interface ScheduleStateShape {
  machines: RoasterMachine[];
  bookings: BatchBooking[];
  loading: boolean;
  error: string;
  filters: ScheduleFilters;
  /** 当前查看日期（YYYY-MM-DD），默认今天 */
  viewDate: string;
  /** 排单烘焙师（本机记住，提交时自动带上，晚到的一单据此看到被谁占了） */
  operator: string;
  notice: string;
}

const OPERATOR_STORAGE_KEY = 'gbroastlog.operator';

function readOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

const today = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
})();

const initialState: ScheduleStateShape = {
  machines: [],
  bookings: [],
  loading: false,
  error: '',
  filters: { keyword: '', machineIds: [], states: [], deferredOnly: false },
  viewDate: today,
  operator: readOperator(),
  notice: '',
};

/* ------------------------------ thunks ------------------------------ */

export const fetchRoasterMachines = createAsyncThunk('schedule/fetchMachines', async () => listRoasterMachines());

export const saveRoasterMachine = createAsyncThunk(
  'schedule/saveMachine',
  async (input: { id?: string; draft: RoasterMachineDraft }) => {
    const stamp = nowIso();
    const row: RoasterMachine = {
      ...input.draft,
      id: input.id ?? createId('rm'),
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (input.id) {
      const existing = (await listRoasterMachines()).find((item) => item.id === input.id);
      if (existing) row.createdAt = existing.createdAt;
    }
    await putRoasterMachine(row);
    return listRoasterMachines();
  },
);

export const deleteRoasterMachine = createAsyncThunk('schedule/deleteMachine', async (id: string) => {
  await removeRoasterMachine(id);
  return listRoasterMachines();
});

export const fetchBatchBookings = createAsyncThunk('schedule/fetchBookings', async () => listBatchBookings());

export const submitBooking = createAsyncThunk<SubmitBookingResult, SubmitBookingInput>(
  'schedule/submitBooking',
  async (input) => submitBatchBooking(input),
);

export const dropBookingThunk = createAsyncThunk(
  'schedule/dropBooking',
  async (id: string) => dropBooking(id),
);

export const voidBookingThunk = createAsyncThunk(
  'schedule/voidBooking',
  async (id: string) => voidBooking(id),
);

export const restoreBookingThunk = createAsyncThunk(
  'schedule/restoreBooking',
  async (id: string) => restoreBooking(id),
);

export const changeChargeThunk = createAsyncThunk(
  'schedule/changeCharge',
  async (input: { id: string; chargeG: number }) => changeBookingCharge(input.id, input.chargeG),
);

/* ------------------------------ slice ------------------------------ */

const scheduleSlice = createSlice({
  name: 'schedule',
  initialState,
  reducers: {
    setScheduleFilters(state, action: PayloadAction<Partial<ScheduleFilters>>) {
      state.filters = { ...state.filters, ...action.payload };
    },
    resetScheduleFilters(state) {
      state.filters = { keyword: '', machineIds: [], states: [], deferredOnly: false };
    },
    setViewDate(state, action: PayloadAction<string>) {
      state.viewDate = action.payload;
    },
    setOperator(state, action: PayloadAction<string>) {
      state.operator = action.payload;
      try {
        localStorage.setItem(OPERATOR_STORAGE_KEY, action.payload);
      } catch {
        // 隐私模式等场景忽略持久化失败
      }
    },
    clearScheduleNotice(state) {
      state.notice = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchRoasterMachines.fulfilled, (state, action) => {
        state.machines = action.payload;
      })
      .addCase(fetchRoasterMachines.rejected, (state, action) => {
        state.error = action.error.message ?? '烘焙机读取失败';
      })
      .addCase(saveRoasterMachine.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(saveRoasterMachine.fulfilled, (state, action) => {
        state.loading = false;
        state.machines = action.payload;
        state.notice = '烘焙机配置已保存，锅次上限即时生效';
      })
      .addCase(saveRoasterMachine.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '烘焙机保存失败';
      })
      .addCase(deleteRoasterMachine.fulfilled, (state, action) => {
        state.machines = action.payload;
        state.notice = '烘焙机已删除';
      })
      .addCase(deleteRoasterMachine.rejected, (state, action) => {
        state.error = action.error.message ?? '烘焙机删除失败';
      })
      .addCase(fetchBatchBookings.fulfilled, (state, action) => {
        state.bookings = action.payload;
      })
      .addCase(fetchBatchBookings.rejected, (state, action) => {
        state.error = action.error.message ?? '锅次账本读取失败';
      })
      .addCase(submitBooking.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(submitBooking.rejected, (state, action) => {
        state.error = action.error.message ?? '排产失败';
      })
      .addCase(dropBookingThunk.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(dropBookingThunk.rejected, (state, action) => {
        state.error = action.error.message ?? '下豆失败';
      })
      .addCase(voidBookingThunk.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(voidBookingThunk.rejected, (state, action) => {
        state.error = action.error.message ?? '作废失败';
      })
      .addCase(restoreBookingThunk.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(restoreBookingThunk.rejected, (state, action) => {
        state.error = action.error.message ?? '恢复失败';
      })
      .addCase(changeChargeThunk.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(changeChargeThunk.rejected, (state, action) => {
        state.error = action.error.message ?? '载量调整失败';
      });
  },
});

export const {
  setScheduleFilters,
  resetScheduleFilters,
  setViewDate,
  setOperator,
  clearScheduleNotice,
} = scheduleSlice.actions;

export const selectScheduleState = (state: RootState): ScheduleStateShape => state.schedule;

/** 当前启用的烘焙机 */
export const selectEnabledMachines = createSelector([selectScheduleState], (scheduleState) =>
  scheduleState.machines.filter((machine) => machine.enabled),
);

export default scheduleSlice.reducer;
