/**
 * /schedule 排产台账
 * 消费 SchedulePot、MachineCapacity、GreenBean、RoastProfile、MachineTemplate（liveQuery 实时订阅）。
 * 交互：机型日锅次上限配置、未来 7 天锅次占用网格（预留/已扣减/作废/空锅）、
 *       锅次作废还预留 / 恢复重占锅 / 下豆完成转扣减、排产人设置、顺延与撞锅提示。
 * 新建烘焙记录（排产）在「烘焙曲线」页完成，这里负责看账与调账。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  CoffeeOutlined,
  EditOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { useAppDispatch, useAppSelector } from '../stores/store';
import {
  consumePot,
  saveCapacity,
  selectCapacities,
  selectOperatorName,
  setOperatorName,
  transitionPotState,
} from '../stores/scheduleSlice';
import { fetchRoastProfiles } from '../stores/roastSlice';
import { fetchGreenBeans } from '../stores/beanSlice';
import {
  DEFAULT_DAILY_POT_LIMIT,
  POT_STATE_COLOR,
  POT_STATE_LABEL,
  type MachineCapacity,
  type SchedulePot,
} from '../types/schedule';
import { potLimitFor } from '../utils/schedule';
import type { GreenBean } from '../types/greenbean';
import type { MachineTemplate, RoastProfile, RoastState } from '../types/roastprofile';
import { ROAST_STATE_COLOR, ROAST_STATE_LABEL } from '../types/roastprofile';

interface PotDrawerState {
  model: string;
  date: string;
}

export default function ScheduleBoard() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();

  const operatorName = useAppSelector(selectOperatorName);
  const capacities = useAppSelector(selectCapacities);

  /** 锅次/生豆/记录/模板走 liveQuery，任何页签改动后这里自动刷新；机型上限走 Redux（保存即更新） */
  const potsTable = useIdbTable<SchedulePot>('schedulePots');
  const beansTable = useIdbTable<GreenBean>('greenBeans');
  const profilesTable = useIdbTable<RoastProfile>('roastProfiles');
  const templatesTable = useIdbTable<MachineTemplate>('machineTemplates');

  const [startDate, setStartDate] = useState<Dayjs>(dayjs().startOf('day'));
  const [drawer, setDrawer] = useState<PotDrawerState | null>(null);
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);
  const [operatorInput, setOperatorInput] = useState(operatorName);

  const beanMap = useMemo(
    () => new Map(beansTable.rows.map((bean) => [bean.id, bean])),
    [beansTable.rows],
  );
  const profileMap = useMemo(
    () => new Map(profilesTable.rows.map((profile) => [profile.id, profile])),
    [profilesTable.rows],
  );

  /** 全部机型：已配置上限的 + 模板里的 + 烘焙记录里出现过的 */
  const models = useMemo(() => {
    const set = new Set<string>();
    capacities.forEach((cap) => set.add(cap.model));
    templatesTable.rows.forEach((template) => set.add(template.model));
    profilesTable.rows.forEach((profile) => set.add(profile.machineModel));
    return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [capacities, templatesTable.rows, profilesTable.rows]);

  const capMap = useMemo(
    () => new Map(capacities.map((cap) => [cap.model, cap.dailyPotLimit])),
    [capacities],
  );

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => startDate.add(index, 'day')),
    [startDate],
  );

  const stats = useMemo(() => {
    const pots = potsTable.rows;
    return {
      total: pots.length,
      reserved: pots.filter((pot) => pot.state === 'reserved').length,
      consumed: pots.filter((pot) => pot.state === 'consumed').length,
      void: pots.filter((pot) => pot.state === 'void').length,
      machines: models.length,
    };
  }, [potsTable.rows, models.length]);

  const potsFor = (model: string, date: string): SchedulePot[] =>
    potsTable.rows
      .filter((pot) => pot.machineModel === model && pot.scheduledDate === date)
      .sort((a, b) => a.potIndex - b.potIndex);

  const refreshAfterAction = (): void => {
    void dispatch(fetchRoastProfiles());
    void dispatch(fetchGreenBeans());
  };

  const handleTransition = async (pot: SchedulePot, state: RoastState): Promise<void> => {
    try {
      const result = await dispatch(transitionPotState({ profileId: pot.profileId, state })).unwrap();
      if (result.ok) {
        message.success(result.message);
      } else {
        message.warning(result.message);
      }
      refreshAfterAction();
    } catch (error) {
      message.error(`操作失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleConsume = async (pot: SchedulePot): Promise<void> => {
    const bean = beanMap.get(pot.greenBeanId);
    const kg = Math.round((pot.chargeG / 1000) * 1000) / 1000;
    modal.confirm({
      title: `下豆完成，按载量扣减生豆库存？`,
      content: bean
        ? `将从「${bean.origin} · ${bean.farm}」（在库 ${bean.stockKg}kg）扣减 ${kg}kg，并把锅次置为「已扣减」。`
        : '未找到关联生豆，仅更新锅次状态。',
      okText: '扣减并完成',
      cancelText: '取消',
      async onOk() {
        const result = await dispatch(consumePot(pot.profileId)).unwrap();
        if (result.ok) message.success(result.message);
        else message.warning(result.message);
        refreshAfterAction();
      },
    });
  };

  const handleSaveCapacity = (model: string, value: number): void => {
    const limit = Math.min(99, Math.max(1, Math.round(Number(value) || DEFAULT_DAILY_POT_LIMIT)));
    void dispatch(saveCapacity({ model, dailyPotLimit: limit }));
  };

  const potActions = (pot: SchedulePot): React.ReactNode => (
    <Space size={4} wrap>
      {pot.state === 'reserved' ? (
        <>
          <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => void handleConsume(pot)}>
            下豆扣减
          </Button>
          <Button size="small" danger icon={<ThunderboltOutlined />} onClick={() => void handleTransition(pot, 'void')}>
            作废
          </Button>
        </>
      ) : null}
      {pot.state === 'consumed' ? (
        <Button size="small" danger icon={<ThunderboltOutlined />} onClick={() => void handleTransition(pot, 'void')}>
          作废回退
        </Button>
      ) : null}
      {pot.state === 'void' ? (
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleTransition(pot, 'recording')}>
          恢复排产
        </Button>
      ) : null}
      <Button
        size="small"
        type="link"
        icon={<EditOutlined />}
        onClick={() => navigate('/curves')}
      >
        记录
      </Button>
    </Space>
  );

  const renderPotChip = (model: string, date: string, potIndex: number): React.ReactNode => {
    const pot = potsFor(model, date).find((item) => item.potIndex === potIndex);
    if (!pot) {
      return (
        <Tooltip key={potIndex} title={`${date} 第 ${potIndex} 锅 · 空锅`}>
          <span className="gb-pot-chip is-empty">{potIndex}</span>
        </Tooltip>
      );
    }
    const bean = beanMap.get(pot.greenBeanId);
    const profile = profileMap.get(pot.profileId);
    const rolledOver = profile ? pot.scheduledDate > profile.roastedAt : false;
    const title = (
      <Space direction="vertical" size={2}>
        <span>
          {date} 第 {pot.potIndex} 锅 · {POT_STATE_LABEL[pot.state]}
          {rolledOver ? '（顺延）' : ''}
        </span>
        <span>
          {bean ? `${bean.origin} · ${bean.farm}` : '（生豆已删除）'} · {pot.chargeG}g
        </span>
        <span>排产人：{pot.operatorName}</span>
        {profile ? <span>记录状态：{ROAST_STATE_LABEL[profile.state]}</span> : null}
      </Space>
    );
    return (
      <Tooltip key={pot.id} title={title}>
        <span
          className={`gb-pot-chip is-${pot.state}`}
          onClick={() => setDrawer({ model, date })}
        >
          {potIndex}
        </span>
      </Tooltip>
    );
  };

  const dayColumns: ColumnsType<MachineCapacity & { key: string }> = days.map((day) => {
    const date = day.format('YYYY-MM-DD');
    const dayPots = potsTable.rows.filter((pot) => pot.scheduledDate === date);
    return {
      title: (
        <Space direction="vertical" size={0}>
          <span>{day.format('MM-DD')}</span>
          <span className="gb-muted">{day.format('ddd')}</span>
        </Space>
      ),
      key: date,
      width: 118,
      render: (_value, record) => {
        const limit = potLimitFor(record.model, capacities);
        const occupied = dayPots.filter(
          (pot) => pot.machineModel === record.model && pot.state !== 'void',
        ).length;
        return (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space size={4} wrap>
              {Array.from({ length: limit }, (_, index) => renderPotChip(record.model, date, index + 1))}
            </Space>
            <Button size="small" type="link" onClick={() => setDrawer({ model: record.model, date })}>
              {occupied} / {limit} 锅
            </Button>
          </Space>
        );
      },
    };
  });

  const columns: ColumnsType<MachineCapacity & { key: string }> = [
    {
      title: '机型',
      dataIndex: 'model',
      key: 'model',
      width: 170,
      fixed: 'left',
      render: (model: string) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{model}</Typography.Text>
          <span className="gb-muted">日上限 {capMap.get(model) ?? DEFAULT_DAILY_POT_LIMIT} 锅</span>
        </Space>
      ),
    },
    ...dayColumns,
  ];

  const tableData = models.map((model) => ({ key: model, model, dailyPotLimit: capMap.get(model) ?? DEFAULT_DAILY_POT_LIMIT, createdAt: '', updatedAt: '' }));

  const drawerPots = drawer ? potsFor(drawer.model, drawer.date) : [];
  const drawerLimit = drawer ? potLimitFor(drawer.model, capacities) : DEFAULT_DAILY_POT_LIMIT;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { paddingTop: 12 } }}>
        <div className="gb-stat-row">
          <StatBadge label="排产锅次" value={stats.total} suffix=" 锅" icon={<CoffeeOutlined />} tone="brown" />
          <StatBadge label="预留中" value={stats.reserved} suffix=" 锅" tone="gold" />
          <StatBadge label="已扣减" value={stats.consumed} suffix=" 锅" tone="green" />
          <StatBadge label="已作废" value={stats.void} suffix=" 锅" tone="red" />
          <StatBadge label="排产机型" value={stats.machines} suffix=" 款" tone="blue" />
          <StatBadge
            label="排产人"
            value={operatorName}
            icon={<UserOutlined />}
            tone="purple"
            hint="晚到的一单会看到锅被谁占了"
          />
        </div>
        <Space wrap>
          <Button icon={<UserOutlined />} onClick={() => { setOperatorInput(operatorName); setOperatorModalOpen(true); }}>
            设置排产人
          </Button>
          <Button icon={<CalendarOutlined />} onClick={() => setStartDate(dayjs().startOf('day'))}>
            回到今天
          </Button>
          <Button type="primary" onClick={() => navigate('/curves')}>
            新建排产（烘焙记录）
          </Button>
        </Space>
      </Card>

      <Card
        title="机型日锅次上限"
        extra={<span className="gb-muted">按机型配置每天最多排几锅；排满自动顺延次日</span>}
        styles={{ body: { paddingTop: 12 } }}
      >
        <Table
          rowKey="model"
          size="small"
          pagination={false}
          dataSource={tableData}
          columns={[
            { title: '机型号', dataIndex: 'model', key: 'model', render: (model: string) => <Typography.Text strong>{model}</Typography.Text> },
            {
              title: '日锅次上限',
              dataIndex: 'dailyPotLimit',
              key: 'dailyPotLimit',
              width: 180,
              render: (_value, record) => (
                <InputNumber
                  min={1}
                  max={99}
                  value={capMap.get(record.model) ?? DEFAULT_DAILY_POT_LIMIT}
                  addonAfter="锅/天"
                  style={{ width: 140 }}
                  onChange={(value) => handleSaveCapacity(record.model, Number(value ?? DEFAULT_DAILY_POT_LIMIT))}
                />
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="未来 7 天锅次占用"
        extra={
          <Space>
            <DatePicker
              value={startDate}
              onChange={(value) => value && setStartDate(value.startOf('day'))}
              allowClear={false}
            />
            <span className="gb-muted">点击锅次查看明细与调账</span>
          </Space>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        {models.length === 0 ? (
          <EmptyPanel
            title="还没有排产"
            description="先在「烘焙曲线」页新建烘焙记录，系统会按机型日上限自动占锅、按载量预留生豆。"
            actionText="新建排产"
            onAction={() => navigate('/curves')}
          />
        ) : (
          <Table
            rowKey="model"
            size="small"
            loading={potsTable.loading}
            columns={columns}
            dataSource={tableData}
            scroll={{ x: 170 + 7 * 118 }}
            pagination={false}
          />
        )}
        <Space size={12} wrap style={{ marginTop: 10 }}>
          <Tag color={POT_STATE_COLOR.reserved}>预留中（生豆已预留、未扣减）</Tag>
          <Tag color={POT_STATE_COLOR.consumed}>已扣减（下豆完成）</Tag>
          <Tag color={POT_STATE_COLOR.void}>已作废（预留已还回）</Tag>
          <span className="gb-muted">虚线空锅 = 还能排；锅次排满会自动顺延到次日。</span>
        </Space>
      </Card>

      <Drawer
        title={drawer ? `${drawer.model} · ${drawer.date} 锅次明细（日上限 ${drawerLimit} 锅）` : '锅次明细'}
        width={560}
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        destroyOnClose
      >
        {drawer ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {Array.from({ length: drawerLimit }, (_, index) => index + 1).map((potIndex) => {
              const pot = drawerPots.find((item) => item.potIndex === potIndex);
              if (!pot) {
                return (
                  <Card key={potIndex} size="small">
                    <Space>
                      <span className="gb-pot-chip is-empty">{potIndex}</span>
                      <span className="gb-muted">第 {potIndex} 锅 · 空锅，可排产</span>
                    </Space>
                  </Card>
                );
              }
              const bean = beanMap.get(pot.greenBeanId);
              const profile = profileMap.get(pot.profileId);
              const rolledOver = profile ? pot.scheduledDate > profile.roastedAt : false;
              return (
                <Card key={pot.id} size="small">
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space wrap>
                      <span className={`gb-pot-chip is-${pot.state}`}>{pot.potIndex}</span>
                      <Tag color={POT_STATE_COLOR[pot.state]}>{POT_STATE_LABEL[pot.state]}</Tag>
                      {rolledOver ? <Tag color="#a8632c">顺延</Tag> : null}
                      {profile ? <Tag color={ROAST_STATE_COLOR[profile.state]}>{ROAST_STATE_LABEL[profile.state]}</Tag> : null}
                    </Space>
                    <Typography.Text strong>
                      {bean ? `${bean.origin} · ${bean.farm}` : '（生豆已删除）'} · {pot.chargeG}g
                    </Typography.Text>
                    <span className="gb-muted">
                      排产人：{pot.operatorName}
                      {bean ? ` · 在库 ${bean.stockKg}kg` : ''}
                    </span>
                    {potActions(pot)}
                  </Space>
                </Card>
              );
            })}
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title="设置排产人"
        open={operatorModalOpen}
        onCancel={() => setOperatorModalOpen(false)}
        onOk={() => {
          dispatch(setOperatorName(operatorInput));
          setOperatorModalOpen(false);
          message.success(`排产人已设为「${operatorInput.trim() || '当班烘焙师'}」`);
        }}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <span className="gb-muted">两人同时占同一锅时，晚到的一单会看到这锅被谁占了。</span>
          <Input
            value={operatorInput}
            onChange={(event) => setOperatorInput(event.target.value)}
            placeholder="如：张烘焙师"
            prefix={<UserOutlined />}
            maxLength={20}
          />
        </Space>
      </Modal>
    </Space>
  );
}
