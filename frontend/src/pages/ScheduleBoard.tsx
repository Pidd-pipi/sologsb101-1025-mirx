/**
 * /schedule 排产记账本
 * 消费 RoasterMachine、BatchBooking、GreenBean、RoastProfile；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
 * 交互：
 *  - 每台烘焙机按机型登记「当天锅次上限」，当天已排 + 已下豆锅次排满即不再接锅，多出的顺延次日。
 *  - 建锅次（=建烘焙记录）时按载量从生豆「可用余量」（在库 - 已排预留）留出这一锅。
 *  - 同机同日同时段只成功一单（唯一索引兜底，含跨标签页并发），晚到的一单提示被谁占了。
 *  - 作废释放时段并归还预留；下豆完成预留转实际扣减；改载量预留与占用马上重算。数据持久化，重开还在。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CalendarOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { useScheduleBoard, type BeanLedger, type MachineDayUsage } from '../hooks/useScheduleBoard';
import { useAppDispatch, useAppSelector } from '../stores/store';
import { fetchGreenBeans } from '../stores/beanSlice';
import { fetchRoastProfiles } from '../stores/roastSlice';
import {
  changeChargeThunk,
  deleteRoasterMachine,
  dropBookingThunk,
  fetchBatchBookings,
  fetchRoasterMachines,
  resetScheduleFilters,
  restoreBookingThunk,
  saveRoasterMachine,
  selectScheduleState,
  setOperator,
  setScheduleFilters,
  setViewDate,
  submitBooking,
  voidBookingThunk,
} from '../stores/scheduleSlice';
import { SlotConflictError } from '../utils/db';
import {
  listSlotOptions,
  todayLocal,
} from '../utils/schedule';
import { BEAN_PROCESS_LABEL, type GreenBean } from '../types/greenbean';
import type { RoastProfile } from '../types/roastprofile';
import {
  BOOKING_STATE_COLOR,
  BOOKING_STATE_LABEL,
  BOOKING_STATE_OPTIONS,
  MAX_DAILY_LIMIT,
  MAX_SLOT_MINUTES,
  MIN_DAILY_LIMIT,
  MIN_SLOT_MINUTES,
  type BatchBooking,
  type BookingState,
  type RoasterMachine,
  type RoasterMachineDraft,
} from '../types/schedule';

interface MachineFormValues {
  model: string;
  dailyLimit: number;
  slotMinutes: number;
  openRange: [Dayjs, Dayjs];
  note: string;
  enabled: boolean;
}

interface BookingFormValues {
  machineId: string;
  greenBeanId: string;
  planDate: Dayjs;
  slotAt: Dayjs;
  chargeG: number;
  operator: string;
  note: string;
}

export default function ScheduleBoardPage() {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const [machineForm] = Form.useForm<MachineFormValues>();
  const [bookingForm] = Form.useForm<BookingFormValues>();

  const scheduleState = useAppSelector(selectScheduleState);

  // 四张表 liveQuery 订阅：本页与另一标签页的写入都会实时推过来
  const machinesTable = useIdbTable<RoasterMachine>('roasterMachines');
  const bookingsTable = useIdbTable<BatchBooking>('batchBookings');
  const beansTable = useIdbTable<GreenBean>('greenBeans');
  const profilesTable = useIdbTable<RoastProfile>('roastProfiles');

  const [machineModalOpen, setMachineModalOpen] = useState(false);
  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [presetProfileId, setPresetProfileId] = useState<string | null>(null);
  const [presetMachineId, setPresetMachineId] = useState<string | null>(null);
  const [chargeEdit, setChargeEdit] = useState<{ id: string; chargeG: number } | null>(null);

  useEffect(() => {
    void dispatch(fetchRoasterMachines());
    void dispatch(fetchBatchBookings());
    void dispatch(fetchGreenBeans());
    void dispatch(fetchRoastProfiles());
  }, [dispatch]);

  const board = useScheduleBoard(
    machinesTable.rows,
    bookingsTable.rows,
    beansTable.rows,
    profilesTable.rows,
    scheduleState.viewDate,
  );

  const beanMap = useMemo(
    () => new Map(beansTable.rows.map((bean) => [bean.id, bean])),
    [beansTable.rows],
  );

  const enabledMachines = machinesTable.rows.filter((machine) => machine.enabled);

  const selects: FilterSelectConfig[] = [
    {
      key: 'machine',
      label: '烘焙机',
      width: 180,
      options: machinesTable.rows.map((machine) => ({
        value: machine.id,
        label: `${machine.model}（上限 ${machine.dailyLimit}）`,
      })),
    },
    { key: 'state', label: '锅次状态', options: BOOKING_STATE_OPTIONS },
  ];

  const handleFilterChange = (key: string, values: string[]): void => {
    if (key === 'machine') dispatch(setScheduleFilters({ machineIds: values }));
    if (key === 'state') dispatch(setScheduleFilters({ states: values as BookingState[] }));
  };

  /** 账本刷新：thunk 改的是 Dexie，liveQuery 会自动推；这里再补拉 redux 里的豆/记录，保证其它页徽标同步 */
  const refreshLinked = async (): Promise<void> => {
    await Promise.all([dispatch(fetchGreenBeans()), dispatch(fetchRoastProfiles())]);
  };

  const guardResult = (error: unknown): string => {
    if (error instanceof SlotConflictError) {
      return `${error.message}（被 ${error.occupant.operator} 占用）`;
    }
    return error instanceof Error ? error.message : '未知错误';
  };

  /* ------------------------------ 烘焙机 ------------------------------ */

  const openCreateMachine = (): void => {
    setEditingMachineId(null);
    machineForm.resetFields();
    machineForm.setFieldsValue({
      model: '',
      dailyLimit: 6,
      slotMinutes: 30,
      openRange: [dayjs('08:30', 'HH:mm'), dayjs('18:00', 'HH:mm')],
      note: '',
      enabled: true,
    });
    setMachineModalOpen(true);
  };

  const openEditMachine = (machine: RoasterMachine): void => {
    setEditingMachineId(machine.id);
    machineForm.setFieldsValue({
      model: machine.model,
      dailyLimit: machine.dailyLimit,
      slotMinutes: machine.slotMinutes,
      openRange: [dayjs(machine.openFrom, 'HH:mm'), dayjs(machine.openTo, 'HH:mm')],
      note: machine.note,
      enabled: machine.enabled,
    });
    setMachineModalOpen(true);
  };

  const handleMachineSubmit = async (values: MachineFormValues): Promise<void> => {
    const [from, to] = values.openRange;
    const draft: RoasterMachineDraft = {
      model: values.model.trim(),
      dailyLimit: Math.round(values.dailyLimit),
      slotMinutes: Math.round(values.slotMinutes),
      openFrom: from.format('HH:mm'),
      openTo: to.format('HH:mm'),
      note: values.note?.trim() ?? '',
      enabled: values.enabled,
    };
    if (!draft.openTo || draft.openTo <= draft.openFrom) {
      message.error('收烘时间要晚于开烘时间');
      return;
    }
    try {
      await dispatch(saveRoasterMachine({ id: editingMachineId ?? undefined, draft })).unwrap();
      message.success(editingMachineId ? '烘焙机已更新，锅次上限即时生效' : '烘焙机已登记');
      setMachineModalOpen(false);
    } catch (error) {
      message.error(`保存失败：${guardResult(error)}`);
    }
  };

  const handleDeleteMachine = (machine: RoasterMachine): void => {
    modal.confirm({
      title: `删除烘焙机「${machine.model}」？`,
      content: '若该机器还有已排产/已下豆锅次会被拒绝（历史账本需可追溯）；仅作废锅次会一并清理。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await dispatch(deleteRoasterMachine(machine.id)).unwrap();
          message.success('烘焙机已删除');
        } catch (error) {
          message.warning(guardResult(error));
        }
      },
    });
  };

  /* ------------------------------ 锅次 ------------------------------ */

  const openCreateBooking = (preset?: { machineId?: string; profileId?: string }): void => {
    if (enabledMachines.length === 0) {
      message.warning('请先登记至少一台烘焙机（机型 + 当天锅次上限）');
      return;
    }
    setPresetProfileId(preset?.profileId ?? null);
    const machineId =
      preset?.machineId ??
      (scheduleState.filters.machineIds.length === 1 ? scheduleState.filters.machineIds[0] : null) ??
      enabledMachines[0]?.id ??
      null;
    setPresetMachineId(machineId);
    bookingForm.resetFields();
    const profile = preset?.profileId
      ? profilesTable.rows.find((item) => item.id === preset.profileId)
      : undefined;
    bookingForm.setFieldsValue({
      machineId: machineId ?? undefined,
      greenBeanId: profile?.greenBeanId ?? beansTable.rows[0]?.id,
      planDate: dayjs(scheduleState.viewDate),
      slotAt: dayjs('09:00', 'HH:mm'),
      chargeG: profile?.chargeG ?? 500,
      operator: scheduleState.operator || '',
      note: '',
    });
    setBookingModalOpen(true);
  };

  const handleBookingSubmit = async (values: BookingFormValues): Promise<void> => {
    const operator = values.operator?.trim() ?? '';
    if (!operator) {
      message.error('请填写排单烘焙师（占用成功后别人能看到是谁排的）');
      return;
    }
    dispatch(setOperator(operator));
    try {
      const result = await dispatch(
        submitBooking({
          machineId: values.machineId,
          greenBeanId: values.greenBeanId,
          planDate: values.planDate.format('YYYY-MM-DD'),
          slotAt: values.slotAt.format('HH:mm'),
          chargeG: Math.round(values.chargeG),
          operator,
          note: values.note?.trim() ?? '',
          profileId: presetProfileId ?? undefined,
        }),
      ).unwrap();
      message.success(result.message, result.deferred ? 6 : 3);
      setBookingModalOpen(false);
      setPresetProfileId(null);
      setPresetMachineId(null);
      await refreshLinked();
    } catch (error) {
      if (error instanceof SlotConflictError) {
        modal.warning({
          title: '该时段已被占用，这一锅没排上',
          content: `${error.occupant.machineModel} ${error.occupant.planDate} ${error.occupant.slotAt} 已由「${error.occupant.operator}」排了 ${error.occupant.chargeG}g（${
            beanMap.get(error.occupant.greenBeanId)?.origin ?? '生豆'
          }）。请换一个时段再提交。`,
          okText: '我知道了',
        });
      } else {
        message.error(`排产失败：${guardResult(error)}`);
      }
    }
  };

  const handleDrop = (booking: BatchBooking): void => {
    const bean = beanMap.get(booking.greenBeanId);
    modal.confirm({
      title: `确认 ${booking.slotAt} 这锅已下豆？`,
      content: `将把预留的 ${booking.chargeG / 1000}kg 转为实际扣减${
        bean ? `（${bean.origin} 扣后余 ${Math.round((bean.stockKg - booking.chargeG / 1000) * 1000) / 1000}kg）` : ''
      }，锅次记为「已下豆」，时段仍占锅次。`,
      okText: '下豆并扣减',
      cancelText: '取消',
      async onOk() {
        try {
          const result = await dispatch(dropBookingThunk(booking.id)).unwrap();
          message.success(result.message);
          await refreshLinked();
        } catch (error) {
          message.warning(guardResult(error));
        }
      },
    });
  };

  const handleVoid = (booking: BatchBooking): void => {
    modal.confirm({
      title: `作废 ${booking.planDate} ${booking.slotAt} 这一锅？`,
      content: `时段占用立即释放，预留的 ${booking.chargeG / 1000}kg 还回生豆可用余量；关联烘焙记录同步置为作废。`,
      okText: '确认作废',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          const result = await dispatch(voidBookingThunk(booking.id)).unwrap();
          message.success(result.message);
          await refreshLinked();
        } catch (error) {
          message.warning(guardResult(error));
        }
      },
    });
  };

  const handleRestore = (booking: BatchBooking): void => {
    void (async () => {
      try {
        const result = await dispatch(restoreBookingThunk(booking.id)).unwrap();
        message.success(result.message);
        await refreshLinked();
      } catch (error) {
        if (error instanceof SlotConflictError) {
          message.warning(`恢复失败：${guardResult(error)}`);
        } else {
          message.warning(guardResult(error));
        }
      }
    })();
  };

  const handleQuickCharge = async (): Promise<void> => {
    if (!chargeEdit) return;
    try {
      const result = await dispatch(
        changeChargeThunk({ id: chargeEdit.id, chargeG: Math.round(chargeEdit.chargeG) }),
      ).unwrap();
      message.success(result.message);
      setChargeEdit(null);
      await refreshLinked();
    } catch (error) {
      message.warning(guardResult(error));
    }
  };

  /* ------------------------------ 表格列 ------------------------------ */

  const filteredDayBookings = useMemo(() => {
    const { keyword, machineIds, states, deferredOnly } = scheduleState.filters;
    const needle = keyword.trim().toLowerCase();
    return board.dayBookings
      .filter((booking) => (machineIds.length > 0 ? machineIds.includes(booking.machineId) : true))
      .filter((booking) => (states.length > 0 ? states.includes(booking.state) : true))
      .filter((booking) => (deferredOnly ? booking.deferred : true))
      .filter((booking) => {
        if (!needle) return true;
        const bean = beanMap.get(booking.greenBeanId);
        const haystack =
          `${booking.machineModel} ${booking.slotAt} ${booking.operator} ${booking.note} ${bean?.origin ?? ''} ${
            bean?.farm ?? ''
          }`.toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) =>
        a.machineModel.localeCompare(b.machineModel, 'zh-Hans-CN') || a.slotAt.localeCompare(b.slotAt),
      );
  }, [board.dayBookings, scheduleState.filters, beanMap]);

  const bookingColumns: ColumnsType<BatchBooking> = [
    {
      title: '时段',
      key: 'slot',
      width: 110,
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong className="gb-mono">
            <ClockCircleOutlined /> {record.slotAt}
          </Typography.Text>
          {record.deferred ? <Tag color="purple">顺延锅次</Tag> : null}
        </Space>
      ),
    },
    {
      title: '烘焙机',
      dataIndex: 'machineModel',
      key: 'machineModel',
      width: 140,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: '生豆',
      key: 'bean',
      width: 210,
      render: (_v, record) => {
        const bean = beanMap.get(record.greenBeanId);
        return bean ? (
          <Space direction="vertical" size={0}>
            <span>{bean.origin}</span>
            <span className="gb-muted">
              {bean.farm} · {BEAN_PROCESS_LABEL[bean.process]}
            </span>
          </Space>
        ) : (
          <Tag>生豆已删除</Tag>
        );
      },
    },
    {
      title: '载量 / 记账',
      key: 'charge',
      width: 190,
      render: (_v, record) =>
        chargeEdit?.id === record.id ? (
          <Space size={4}>
            <InputNumber
              size="small"
              min={50}
              max={3000}
              step={50}
              value={chargeEdit.chargeG}
              onChange={(value) => setChargeEdit({ id: record.id, chargeG: Number(value ?? 0) })}
              addonAfter="g"
              style={{ width: 120 }}
            />
            <Button size="small" type="primary" onClick={() => void handleQuickCharge()}>
              保存
            </Button>
            <Button size="small" onClick={() => setChargeEdit(null)}>
              取消
            </Button>
          </Space>
        ) : (
          <Space size={6} wrap>
            <Tag color="#7a5230" className="gb-mono">
              {record.chargeG} g
            </Tag>
            <Tooltip title="改载量后预留与占用马上重算">
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => setChargeEdit({ id: record.id, chargeG: record.chargeG })}
              />
            </Tooltip>
            <span className="gb-muted">
              {record.state === 'booked'
                ? `预留 ${record.chargeG / 1000}kg`
                : record.state === 'dropped'
                  ? `实扣 ${record.chargeG / 1000}kg`
                  : '预留已归还'}
            </span>
          </Space>
        ),
    },
    {
      title: '排单烘焙师',
      dataIndex: 'operator',
      key: 'operator',
      width: 110,
      render: (value: string) => <Tag icon={<UserOutlined />}>{value}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 92,
      render: (value: BookingState) => <Tag color={BOOKING_STATE_COLOR[value]}>{BOOKING_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '备注',
      dataIndex: 'note',
      key: 'note',
      render: (value: string) => <span className="gb-muted">{value || '—'}</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4} wrap>
          {record.state === 'booked' ? (
            <>
              <Button size="small" type="primary" icon={<DownOutlined />} onClick={() => handleDrop(record)}>
                下豆
              </Button>
              <Button size="small" danger icon={<StopOutlined />} onClick={() => handleVoid(record)}>
                作废
              </Button>
            </>
          ) : null}
          {record.state === 'void' ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => handleRestore(record)}>
              恢复排产
            </Button>
          ) : null}
          {record.state === 'dropped' ? <span className="gb-muted">已计入当天锅次</span> : null}
        </Space>
      ),
    },
  ];

  const beanColumns: ColumnsType<BeanLedger> = [
    {
      title: '生豆',
      key: 'bean',
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.bean.origin}</Typography.Text>
          <span className="gb-muted">{record.bean.farm}</span>
        </Space>
      ),
    },
    {
      title: '在库 (kg)',
      dataIndex: 'stockKg',
      key: 'stockKg',
      width: 110,
      align: 'right',
      render: (value: number) => <span className="gb-mono">{value}</span>,
    },
    {
      title: '已排预留 (kg)',
      dataIndex: 'reservedKg',
      key: 'reservedKg',
      width: 130,
      align: 'right',
      render: (value: number) => (
        <Tag color={value > 0 ? '#c9963c' : 'default'} className="gb-mono">
          {value}
        </Tag>
      ),
    },
    {
      title: '可用余量 (kg)',
      dataIndex: 'availableKg',
      key: 'availableKg',
      width: 130,
      align: 'right',
      sorter: (a, b) => a.availableKg - b.availableKg,
      render: (value: number, record) => (
        <Tag color={record.overReserved ? '#b3372f' : value <= 2 ? '#d48806' : '#2f6f4f'} className="gb-mono">
          {value}
        </Tag>
      ),
    },
  ];

  const machineColumns: ColumnsType<MachineDayUsage> = [
    {
      title: '机型',
      key: 'model',
      width: 180,
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.machine.model}</Typography.Text>
          <span className="gb-muted">
            {record.machine.openFrom} - {record.machine.openTo} · {record.machine.slotMinutes} 分钟/锅
            {!record.machine.enabled ? ' · 已停用' : ''}
          </span>
        </Space>
      ),
    },
    {
      title: `当天锅次（${scheduleState.viewDate}）`,
      key: 'usage',
      render: (_v, record) => (
        <Space size={12} style={{ width: '100%' }}>
          <Progress
            percent={record.limit > 0 ? Math.min(100, Math.round((record.occupied / record.limit) * 100)) : 0}
            size="small"
            style={{ width: 200 }}
            status={record.full ? 'exception' : 'active'}
            format={() => `${record.occupied}/${record.limit}`}
          />
          <Space size={4}>
            <Tag color="#c9963c">已排 {record.booked}</Tag>
            <Tag color="#2f6f4f">已下豆 {record.dropped}</Tag>
            {record.full ? <Tag color="#b3372f">已排满</Tag> : <Tag color="blue">还可接 {record.remaining} 锅</Tag>}
          </Space>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => openCreateBooking({ machineId: record.machine.id })}>
            排一锅
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditMachine(record.machine)}>
            上限
          </Button>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => handleDeleteMachine(record.machine)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const isToday = scheduleState.viewDate === todayLocal();

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <FilterBar
        keyword={scheduleState.filters.keyword}
        onKeywordChange={(keyword) => dispatch(setScheduleFilters({ keyword }))}
        selects={selects}
        value={{
          machine: scheduleState.filters.machineIds,
          state: scheduleState.filters.states,
        }}
        onChange={handleFilterChange}
        onReset={() => dispatch(resetScheduleFilters())}
        searchPlaceholder="搜索机型 / 烘焙师 / 生豆 / 备注"
        summary={
          <StatBadge compact label="当天锅次" value={board.dayBookings.length} suffix=" 单" tone="gold" />
        }
        extra={
          <Space>
            <DatePicker
              allowClear={false}
              value={dayjs(scheduleState.viewDate)}
              onChange={(value: Dayjs | null) => value && dispatch(setViewDate(value.format('YYYY-MM-DD')))}
            />
            <Tooltip title="回到今天">
              <Button icon={<CalendarOutlined />} onClick={() => dispatch(setViewDate(todayLocal()))}>
                今天
              </Button>
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreateBooking()}>
              排一锅
            </Button>
          </Space>
        }
      />

      <Card
        title={`当天锅次上限占用 · ${scheduleState.viewDate}${isToday ? '（今天）' : ''}`}
        extra={
          <Space>
            <Input
              size="small"
              prefix={<UserOutlined />}
              placeholder="我是哪位烘焙师"
              value={scheduleState.operator}
              onChange={(event) => dispatch(setOperator(event.target.value))}
              style={{ width: 150 }}
            />
            <Button size="small" icon={<PlusOutlined />} onClick={openCreateMachine}>
              登记烘焙机
            </Button>
          </Space>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        <div className="gb-stat-row">
          <StatBadge label="烘焙机" value={machinesTable.rows.length} suffix=" 台" tone="brown" icon={<ThunderboltOutlined />} />
          <StatBadge label="当天已排/下豆" value={board.dayBookings.filter((b) => b.state !== 'void').length} suffix=" 锅" tone="gold" />
          <StatBadge label="已满机型" value={board.machineUsage.filter((usage) => usage.full).length} suffix=" 台" tone="red" />
          <StatBadge label="全库已预留" value={board.totalReservedKg} suffix=" kg" tone="blue" hint="所有「已排产」锅次按载量预留的生豆合计" />
          <StatBadge label="待补排记录" value={board.unscheduledProfiles.length} suffix=" 条" tone="green" hint="记录中但还没排进锅次的烘焙记录" />
          <StatBadge label="顺延锅次" value={board.dayBookings.filter((b) => b.deferred).length} suffix=" 锅" tone="purple" />
        </div>

        {machinesTable.rows.length === 0 ? (
          <EmptyPanel
            title="还没有烘焙机"
            description="先按机型登记烘焙机与当天锅次上限、时段粒度。锅次排满后系统不再接锅，多出的顺延次日。"
            actionText="登记烘焙机"
            onAction={openCreateMachine}
          />
        ) : (
          <Table
            className="gb-table"
            rowKey={(record) => record.machine.id}
            size="small"
            loading={machinesTable.loading}
            columns={machineColumns}
            dataSource={board.machineUsage}
            pagination={false}
          />
        )}
      </Card>

      <Card
        title="生豆占用账（在库 / 已排预留 / 可用余量）"
        extra={<span className="gb-muted">可用余量 = 在库 - 所有「已排产」锅次预留；下豆后转为实际扣减</span>}
        styles={{ body: { paddingTop: 12 } }}
      >
        {board.beanLedgers.some((ledger) => ledger.overReserved) ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="有生豆预留已超过在库量"
            description="通常是在库重量被直接改小导致；请补货，或作废/下调相关已排产锅次的载量。"
          />
        ) : null}
        <Table
          className="gb-table"
          rowKey={(record) => record.bean.id}
          size="small"
          loading={beansTable.loading}
          columns={beanColumns}
          dataSource={board.beanLedgers}
          pagination={false}
        />
      </Card>

      {board.unscheduledProfiles.length > 0 ? (
        <Card size="small" title={`待补排的烘焙记录（${board.unscheduledProfiles.length}）`} styles={{ body: { paddingTop: 10 } }}>
          <Space wrap size={[8, 8]}>
            {board.unscheduledProfiles.map((profile) => {
              const bean = beanMap.get(profile.greenBeanId);
              return (
                <Tag
                  key={profile.id}
                  style={{ padding: '4px 8px', borderStyle: 'dashed' }}
                  color="gold"
                >
                  <Space size={6}>
                    <span>{profile.machineModel}</span>
                    <span className="gb-mono">{profile.chargeG}g</span>
                    <span className="gb-muted">{bean?.origin ?? '生豆已删'}</span>
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0 }}
                      onClick={() => openCreateBooking({ profileId: profile.id })}
                    >
                      排进锅次
                    </Button>
                  </Space>
                </Tag>
              );
            })}
          </Space>
        </Card>
      ) : null}

      <Card
        title={`锅次账本 · ${scheduleState.viewDate}`}
        extra={<span className="gb-muted">同机同时段只成功一单；作废归还预留，下豆转实际扣减</span>}
        styles={{ body: { paddingTop: 12 } }}
      >
        {filteredDayBookings.length === 0 ? (
          <EmptyPanel
            title={board.dayBookings.length === 0 ? '当天还没有排锅' : '没有符合筛选条件的锅次'}
            description="选择烘焙机、日期与时段后排一锅；建单即按载量从生豆可用余量中预留。"
            actionText="排一锅"
            onAction={() => openCreateBooking()}
            secondaryText="重置筛选"
            secondaryIcon="none"
            onSecondary={() => dispatch(resetScheduleFilters())}
            size="small"
          />
        ) : (
          <Table
            className="gb-table"
            rowKey="id"
            size="small"
            loading={bookingsTable.loading}
            columns={bookingColumns}
            dataSource={filteredDayBookings}
            scroll={{ x: 1200 }}
            pagination={{ pageSize: 10, showTotal: (total) => `共 ${total} 锅` }}
          />
        )}
      </Card>

      <Card size="small" title="记账规则" styles={{ body: { paddingTop: 10 } }}>
        <Space direction="vertical" size={4}>
          <span className="gb-muted">· 每台机器按机型记当天锅次上限；已排产 + 已下豆都占锅，排满不再接锅，多出的顺延到次日空闲时段。</span>
          <span className="gb-muted">· 建锅次（同时建烘焙记录）按载量从「可用余量 = 在库 − 其它已排预留」留豆；余量不足直接拒绝。</span>
          <span className="gb-muted">· 两人同时提交同一台机器同一时段只成功一单（跨标签页同样生效），晚到的一单会看到被哪位烘焙师占用。</span>
          <span className="gb-muted">· 作废：释放时段、预留还回生豆；下豆：预留转实际扣减；改载量：预留与占用立即重算。数据存本机，重开页面还在。</span>
        </Space>
      </Card>

      {/* 烘焙机配置弹窗 */}
      <Modal
        title={editingMachineId ? '编辑烘焙机锅次上限' : '登记烘焙机'}
        open={machineModalOpen}
        onCancel={() => setMachineModalOpen(false)}
        onOk={() => machineForm.submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={machineForm} layout="vertical" onFinish={handleMachineSubmit}>
          <Form.Item
            name="model"
            label="机型号"
            rules={[{ required: true, message: '请填写机型号' }, { min: 2, message: '机型号至少 2 个字符' }]}
          >
            <AutoComplete
              options={Array.from(new Set([...machinesTable.rows.map((m) => m.model), 'HB-M6', 'Giesen W6A', 'Probat P12', 'Mill City 500g'])).map(
                (model) => ({ value: model }),
              )}
              placeholder="如：HB-M6"
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item
            name="dailyLimit"
            label="当天锅次上限"
            extra="当天已排产 + 已下豆锅次达到此值即不再接锅，多出的顺延次日"
            rules={[
              { required: true, message: '请填写当天锅次上限' },
              {
                validator: (_r, value: number) =>
                  Number.isFinite(value) && value >= MIN_DAILY_LIMIT && value <= MAX_DAILY_LIMIT
                    ? Promise.resolve()
                    : Promise.reject(new Error(`上限应在 ${MIN_DAILY_LIMIT} - ${MAX_DAILY_LIMIT} 锅之间`)),
              },
            ]}
          >
            <InputNumber min={MIN_DAILY_LIMIT} max={MAX_DAILY_LIMIT} step={1} style={{ width: '100%' }} addonAfter="锅/天" />
          </Form.Item>
          <Form.Item
            name="slotMinutes"
            label="时段粒度（分钟/锅）"
            rules={[
              { required: true, message: '请填写时段粒度' },
              {
                validator: (_r, value: number) =>
                  Number.isFinite(value) && value >= MIN_SLOT_MINUTES && value <= MAX_SLOT_MINUTES
                    ? Promise.resolve()
                    : Promise.reject(new Error(`粒度应在 ${MIN_SLOT_MINUTES} - ${MAX_SLOT_MINUTES} 分钟之间`)),
              },
            ]}
          >
            <InputNumber min={MIN_SLOT_MINUTES} max={MAX_SLOT_MINUTES} step={5} style={{ width: '100%' }} addonAfter="分钟" />
          </Form.Item>
          <Form.Item name="openRange" label="开烘 - 收烘时间" rules={[{ required: true, message: '请选择营业时间' }]}>
            <TimePicker.RangePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ max: 40, message: '不超过 40 个字符' }]}>
            <Input placeholder="如：出品主力机，每天 6 锅" />
          </Form.Item>
          <Form.Item name="enabled" label="启用排产" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 排一锅弹窗 */}
      <BookingModal
        open={bookingModalOpen}
        form={bookingForm}
        machines={enabledMachines}
        beans={beansTable.rows}
        bookings={bookingsTable.rows}
        presetMachineId={presetMachineId}
        presetProfileId={presetProfileId}
        profiles={profilesTable.rows}
        onCancel={() => {
          setBookingModalOpen(false);
          setPresetProfileId(null);
          setPresetMachineId(null);
        }}
        onSubmit={() => bookingForm.submit()}
        onFinish={handleBookingSubmit}
      />
    </Space>
  );
}

/* --------------------------- 排一锅弹窗（时段占用可视化） --------------------------- */

interface BookingModalProps {
  open: boolean;
  form: ReturnType<typeof Form.useForm<BookingFormValues>>[0];
  machines: RoasterMachine[];
  beans: GreenBean[];
  bookings: BatchBooking[];
  profiles: RoastProfile[];
  presetMachineId: string | null;
  presetProfileId: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  onFinish: (values: BookingFormValues) => void;
}

function BookingModal({
  open,
  form,
  machines,
  beans,
  bookings,
  profiles,
  presetMachineId,
  presetProfileId,
  onCancel,
  onSubmit,
  onFinish,
}: BookingModalProps) {
  const machineId = Form.useWatch('machineId', form) as string | undefined;
  const planDate = Form.useWatch('planDate', form) as Dayjs | undefined;
  const slotAt = Form.useWatch('slotAt', form) as Dayjs | undefined;
  const greenBeanId = Form.useWatch('greenBeanId', form) as string | undefined;
  const chargeG = Number(Form.useWatch('chargeG', form) ?? 0);

  const machine = machines.find((item) => item.id === machineId) ?? machines.find((item) => item.id === presetMachineId);
  const dateText = planDate ? planDate.format('YYYY-MM-DD') : '';

  const slots = useMemo(() => {
    if (!machine || !dateText) return [];
    return listSlotOptions(machine, bookings, dateText);
  }, [machine, bookings, dateText]);

  const usage = useMemo(() => {
    if (!machine || !dateText) return null;
    const inDay = bookings.filter((b) => b.machineId === machine.id && b.planDate === dateText && b.state !== 'void');
    return { occupied: inDay.length, limit: machine.dailyLimit, full: inDay.length >= machine.dailyLimit };
  }, [machine, bookings, dateText]);

  const bean = beans.find((item) => item.id === greenBeanId);
  const otherReservedKg = useMemo(() => {
    if (!bean) return 0;
    const total = bookings
      .filter((b) => b.greenBeanId === bean.id && b.state === 'booked')
      .reduce((acc, b) => acc + b.chargeG / 1000, 0);
    return Math.round(total * 1000) / 1000;
  }, [bookings, bean]);
  const availableKg = bean ? Math.round((bean.stockKg - otherReservedKg) * 1000) / 1000 : 0;
  const needKg = Math.round((chargeG / 1000) * 1000) / 1000;
  const enough = bean ? availableKg + 1e-6 >= needKg : false;

  return (
    <Modal
      title={presetProfileId ? '补排烘焙记录进锅次' : '排一锅（建烘焙记录 + 预留生豆）'}
      open={open}
      onCancel={onCancel}
      onOk={onSubmit}
      okText="提交排产"
      cancelText="取消"
      destroyOnClose
      width={620}
    >
      <Form form={form} layout="vertical" onFinish={onFinish}>
        {presetProfileId ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`补排已有烘焙记录：${
              profiles.find((profile) => profile.id === presetProfileId)?.machineModel ?? ''
            }（提交后占用时段并预留生豆，不再新建记录）`}
          />
        ) : null}
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="machineId"
            label="烘焙机"
            style={{ flex: 1 }}
            rules={[{ required: true, message: '请选择烘焙机' }]}
          >
            <Select
              placeholder="选择烘焙机"
              options={machines.map((item) => ({
                value: item.id,
                label: `${item.model}（当天上限 ${item.dailyLimit} 锅）`,
              }))}
            />
          </Form.Item>
          <Form.Item name="planDate" label="日期" style={{ flex: 1 }} rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Space>

        {usage ? (
          <Alert
            style={{ marginBottom: 12 }}
            type={usage.full ? 'error' : 'warning'}
            showIcon
            message={
              usage.full
                ? `${dateText} 该机型 ${usage.occupied}/${usage.limit} 锅已排满，提交后这一锅会顺延到次日空闲时段`
                : `${dateText} 已占 ${usage.occupied}/${usage.limit} 锅，还可接 ${usage.limit - usage.occupied} 锅`
            }
          />
        ) : null}

        <Form.Item label="时段（同一时段只能成功一单）">
          <Space wrap size={[6, 6]}>
            {slots.length === 0 ? (
              <Typography.Text type="secondary">请先选择烘焙机与日期</Typography.Text>
            ) : (
              slots.map((slot) => (
                <Button
                  key={slot.slotAt}
                  size="small"
                  type={slotAt?.format?.('HH:mm') === slot.slotAt ? 'primary' : 'default'}
                  danger={slot.occupied}
                  disabled={slot.occupied}
                  onClick={() => form.setFieldsValue({ slotAt: dayjs(slot.slotAt, 'HH:mm') })}
                >
                  {slot.slotAt}
                  {slot.occupied ? ` · ${slot.occupant?.operator ?? '占用'}` : ''}
                </Button>
              ))
            )}
          </Space>
        </Form.Item>
        <Form.Item name="slotAt" hidden rules={[{ required: true, message: '请点选一个时段' }]}>
          <TimePicker format="HH:mm" />
        </Form.Item>

        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="greenBeanId"
            label="生豆"
            style={{ flex: 1 }}
            rules={[{ required: true, message: '请选择生豆' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择生豆批次"
              options={beans.map((item) => ({
                value: item.id,
                label: `${item.origin} · ${item.farm}（在库 ${item.stockKg}kg）`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="chargeG"
            label="载量（克）"
            style={{ flex: 1 }}
            rules={[
              { required: true, message: '请填写载量' },
              {
                validator: (_r, value: number) =>
                  Number.isFinite(value) && value >= 50 && value <= 3000
                    ? Promise.resolve()
                    : Promise.reject(new Error('载量应在 50 - 3000 克之间')),
              },
            ]}
          >
            <InputNumber min={50} max={3000} step={50} style={{ width: '100%' }} addonAfter="g" />
          </Form.Item>
        </Space>

        {bean ? (
          <Alert
            style={{ marginBottom: 12 }}
            type={enough ? 'success' : 'error'}
            showIcon
            message={
              enough
                ? `${bean.origin}：在库 ${bean.stockKg}kg - 其它已排预留 ${otherReservedKg}kg = 可用 ${availableKg}kg，本锅预留 ${needKg}kg 后余 ${Math.round(
                    (availableKg - needKg) * 1000,
                  ) / 1000}kg`
                : `可用余量不足：在库 ${bean.stockKg}kg - 预留 ${otherReservedKg}kg = 可用 ${availableKg}kg < 本锅 ${needKg}kg`
            }
          />
        ) : null}

        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="operator"
            label="排单烘焙师"
            style={{ flex: 1 }}
            rules={[{ required: true, message: '请填写排单烘焙师' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="如：阿May" />
          </Form.Item>
          <Form.Item name="note" label="备注" style={{ flex: 1 }} rules={[{ max: 40, message: '不超过 40 字' }]}>
            <Input placeholder="如：满锅 / 特殊火力" />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
