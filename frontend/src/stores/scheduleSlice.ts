/**
 * 排产台账 slice：机型日锅次上限、锅次占用账、排产/改期/作废/恢复/下豆扣减。
 * 跨页状态（锅次预留与占用、可用余量）统一放这里，页面只通过 useSelector / useDispatch 交互。
 */
import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RoastProfile, RoastProfileDraft, RoastState } from '../types/roastprofile';
import type { MachineCapacity, SchedulePot } from '../types/schedule';
import {
  claimScheduleSlot,
  consumeStockForProfile,
  createId,
  listMachineCapacities,
  listRoastProfiles,
  listSchedulePots,
  nowIso,
  putMachineCapacity,
  transitionRoastState,
  type ClaimScheduleResult,
  type StockConsumeResult,
  type TransitionResult,
} from '../utils/db';
import {
  availableKgOfBean,
  findEarliestSlot,
  loadOperatorName,
  potLimitFor,
  saveOperatorName,
  type SlotRef,
} from '../utils/schedule';
import type { RootState } from './store';

interface ScheduleState {
  capacities: MachineCapacity[];
  pots: SchedulePot[];
  loading: boolean;
  error: string;
  notice: string;
  operatorName: string;
}

const initialState: ScheduleState = {
  capacities: [],
  pots: [],
  loading: false,
  error: '',
  notice: '',
  operatorName: loadOperatorName(),
};

export const fetchSchedule = createAsyncThunk('schedule/fetchAll', async () => {
  const [capacities, pots] = await Promise.all([listMachineCapacities(), listSchedulePots()]);
  return { capacities, pots };
});

export const saveCapacity = createAsyncThunk(
  'schedule/saveCapacity',
  async (input: { model: string; dailyPotLimit: number }) => {
    const [capacities, pots] = await Promise.all([
      putMachineCapacity(input.model, input.dailyPotLimit),
      listSchedulePots(),
    ]);
    return { capacities, pots, message: `${input.model} 日锅次上限已设为 ${input.dailyPotLimit} 锅` };
  },
);

type ClaimPayload = ClaimScheduleResult & { capacities: MachineCapacity[]; pots: SchedulePot[] };

/** 新建烘焙记录：原子完成「预留生豆 + 占锅 + 写记录」，锅满顺延次日，撞锅看到被谁占 */
export const createScheduledRoast = createAsyncThunk<ClaimPayload, RoastProfileDraft, { state: RootState }>(
  'schedule/createRoast',
  async (draft, { getState }) => {
    const operatorName = getState().schedule.operatorName || loadOperatorName();
    const stamp = nowIso();
    const profile: RoastProfile = { ...draft, id: createId('rp'), createdAt: stamp, updatedAt: stamp };
    const result = await claimScheduleSlot({ profile, operatorName, mode: 'create' });
    const [capacities, pots] = await Promise.all([listMachineCapacities(), listSchedulePots()]);
    return { ...result, capacities, pots };
  },
);

/** 编辑烘焙记录：载量/机型/日期/生豆改动后立即重算预留与占用（旧锅释放、重新顺延占锅） */
export const updateScheduledRoast = createAsyncThunk<
  ClaimPayload,
  { id: string; draft: RoastProfileDraft },
  { state: RootState }
>('schedule/updateRoast', async (input, { getState }) => {
  const operatorName = getState().schedule.operatorName || loadOperatorName();
  const existing = (await listRoastProfiles()).find((profile) => profile.id === input.id);
  const stamp = nowIso();
  const profile: RoastProfile = {
    ...input.draft,
    id: input.id,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  const result = await claimScheduleSlot({ profile, operatorName, mode: 'update' });
  const [capacities, pots] = await Promise.all([listMachineCapacities(), listSchedulePots()]);
  return { ...result, capacities, pots };
});

type TransitionPayload = TransitionResult & { capacities: MachineCapacity[]; pots: SchedulePot[] };

/** 状态流转：作废还预留 / 恢复重占锅 / 完成转扣减 */
export const transitionPotState = createAsyncThunk<TransitionPayload, { profileId: string; state: RoastState }>(
  'schedule/transitionState',
  async (input) => {
    const result = await transitionRoastState(input.profileId, input.state);
    const [capacities, pots] = await Promise.all([listMachineCapacities(), listSchedulePots()]);
    return { ...result, capacities, pots };
  },
);

type ConsumePayload = StockConsumeResult & { capacities: MachineCapacity[]; pots: SchedulePot[] };

/** 下豆完成：预留转实际扣减，锅次 reserved→consumed */
export const consumePot = createAsyncThunk<ConsumePayload, string>('schedule/consumePot', async (profileId) => {
  const result = await consumeStockForProfile(profileId);
  const [capacities, pots] = await Promise.all([listMachineCapacities(), listSchedulePots()]);
  return { ...result, capacities, pots };
});

const scheduleSlice = createSlice({
  name: 'schedule',
  initialState,
  reducers: {
    setOperatorName(state, action: PayloadAction<string>) {
      state.operatorName = action.payload.trim() || loadOperatorName();
      saveOperatorName(state.operatorName);
    },
    clearScheduleNotice(state) {
      state.notice = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSchedule.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(fetchSchedule.fulfilled, (state, action) => {
        state.loading = false;
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
      })
      .addCase(fetchSchedule.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '排产台账读取失败';
      })
      .addCase(saveCapacity.fulfilled, (state, action) => {
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
        state.notice = action.payload.message;
      })
      .addCase(saveCapacity.rejected, (state, action) => {
        state.error = action.error.message ?? '日锅次上限保存失败';
      })
      .addCase(createScheduledRoast.fulfilled, (state, action) => {
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
        state.notice = action.payload.message;
      })
      .addCase(createScheduledRoast.rejected, (state, action) => {
        state.error = action.error.message ?? '排产失败';
      })
      .addCase(updateScheduledRoast.fulfilled, (state, action) => {
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
        state.notice = action.payload.message;
      })
      .addCase(updateScheduledRoast.rejected, (state, action) => {
        state.error = action.error.message ?? '排产更新失败';
      })
      .addCase(transitionPotState.fulfilled, (state, action) => {
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
        state.notice = action.payload.message;
      })
      .addCase(transitionPotState.rejected, (state, action) => {
        state.error = action.error.message ?? '锅次状态流转失败';
      })
      .addCase(consumePot.fulfilled, (state, action) => {
        state.capacities = action.payload.capacities;
        state.pots = action.payload.pots;
        state.notice = action.payload.message;
      })
      .addCase(consumePot.rejected, (state, action) => {
        state.error = action.error.message ?? '下豆扣减失败';
      });
  },
});

export const { setOperatorName, clearScheduleNotice } = scheduleSlice.actions;

export const selectScheduleState = (state: RootState): ScheduleState => state.schedule;

export const selectCapacities = createSelector([selectScheduleState], (state) => state.capacities);
export const selectSchedulePots = createSelector([selectScheduleState], (state) => state.pots);
export const selectOperatorName = createSelector([selectScheduleState], (state) => state.operatorName);

/** 各生豆的可用余量（kg）= 在库 − 预留中 */
export const selectAvailableKgMap = createSelector(
  [selectScheduleState, (state: RootState) => state.beans.greenBeans],
  (scheduleState, greenBeans) => {
    const map: Record<string, number> = {};
    greenBeans.forEach((bean) => {
      map[bean.id] = availableKgOfBean(bean, scheduleState.pots);
    });
    return map;
  },
);

export interface SchedulePreview {
  limit: number;
  slot: SlotRef | null;
  rolledOver: boolean;
  availableKg: number;
  needKg: number;
  canAfford: boolean;
}

/** 新建/编辑前排产预览：机型日上限、最早锅次（满则顺延）、生豆可用余量是否够扣 */
export const selectSchedulePreview = createSelector(
  [
    selectScheduleState,
    (state: RootState) => state.beans.greenBeans,
    (
      _state: RootState,
      params: { machineModel: string; date: string; beanId: string; chargeG: number; excludeProfileId?: string },
    ) => params,
  ],
  (scheduleState, greenBeans, params): SchedulePreview => {
    const { machineModel, date, beanId, chargeG, excludeProfileId } = params;
    const limit = potLimitFor(machineModel, scheduleState.capacities);
    const slot = findEarliestSlot(scheduleState.pots, machineModel, date, limit);
    const bean = greenBeans.find((item) => item.id === beanId);
    const availableKg = availableKgOfBean(bean, scheduleState.pots, excludeProfileId);
    const needKg = Math.round((chargeG / 1000) * 1000) / 1000;
    return {
      limit,
      slot,
      rolledOver: slot ? slot.date > date : false,
      availableKg,
      needKg,
      canAfford: availableKg + 1e-6 >= needKg,
    };
  },
);

export const selectScheduleStats = createSelector([selectScheduleState], (state) => {
  const pots = state.pots;
  return {
    total: pots.length,
    reserved: pots.filter((pot) => pot.state === 'reserved').length,
    consumed: pots.filter((pot) => pot.state === 'consumed').length,
    void: pots.filter((pot) => pot.state === 'void').length,
    machines: new Set(pots.map((pot) => pot.machineModel)).size,
  };
});

export default scheduleSlice.reducer;
