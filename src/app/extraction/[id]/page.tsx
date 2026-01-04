'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Container,
  Title,
  Stack,
  Paper,
  Text,
  Group,
  Button,
  Badge,
  Modal,
  Alert,
  Loader,
  Card,
  SimpleGrid,
  TextInput,
  Select,
  NumberInput,
  ActionIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconDownload,
  IconCheck,
  IconPlus,
  IconAlertTriangle,
  IconCircleCheck,
  IconTrash,
} from '@tabler/icons-react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import type { ColDef, CellValueChangedEvent } from 'ag-grid-community';
import type { RentRollExtraction, MVPUnit, UnitStatus, ValidationIssue, SummaryStats } from '@/lib/types';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

const STATUS_OPTIONS: { value: UnitStatus; label: string }[] = [
  { value: 'occupied', label: 'Occupied' },
  { value: 'vacant', label: 'Vacant' },
  { value: 'notice', label: 'Notice' },
  { value: 'model', label: 'Model' },
  { value: 'down', label: 'Down' },
  { value: 'applicant', label: 'Applicant' },
];

function ValidationIssuesList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <Alert icon={<IconCircleCheck size={16} />} color="green" variant="light">
        No validation issues found
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      {issues.map((issue, index) => (
        <Alert
          key={index}
          icon={<IconAlertTriangle size={16} />}
          color={issue.severity === 'critical' ? 'red' : issue.severity === 'warning' ? 'yellow' : 'blue'}
          variant="light"
          title={issue.type.replace('_', ' ').toUpperCase()}
        >
          {issue.message}
        </Alert>
      ))}
    </Stack>
  );
}

function formatModelName(model: string | null): string {
  if (!model) return '—';
  if (model.includes('opus')) return 'Opus 4.5';
  if (model.includes('sonnet-4-5')) return 'Sonnet 4.5';
  if (model.includes('sonnet')) return 'Sonnet 4';
  return model;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function UnitCountCard({ extraction }: { extraction: RentRollExtraction }) {
  const getCountStatus = () => {
    if (extraction.countMatch === true) {
      return { color: 'green', icon: <IconCircleCheck size={20} />, text: 'Verified' };
    }
    if (extraction.countMatch === false) {
      return { color: 'red', icon: <IconAlertTriangle size={20} />, text: 'Mismatch!' };
    }
    return { color: 'yellow', icon: <IconAlertTriangle size={20} />, text: 'Unverified' };
  };

  const status = getCountStatus();

  return (
    <Card withBorder p="md">
      <Group justify="space-between">
        <div>
          <Text size="sm" c="dimmed">Extracted Units</Text>
          <Text size="xl" fw={700}>{extraction.extractedUnitCount}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Stated in Document</Text>
          <Text size="xl" fw={700}>
            {extraction.statedUnitCount ?? '—'}
          </Text>
        </div>
        <div>
          <Badge size="lg" color={status.color} leftSection={status.icon}>
            {status.text}
          </Badge>
        </div>
        <div>
          <Text size="sm" c="dimmed">Model</Text>
          <Text size="lg" fw={600}>{formatModelName(extraction.modelUsed)}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Tokens</Text>
          <Text size="lg" fw={600}>{formatTokens(extraction.totalTokens)}</Text>
        </div>
      </Group>
    </Card>
  );
}

function SummaryStatsCard({ stats }: { stats: SummaryStats | null }) {
  if (!stats) {
    return null;
  }

  const formatCurrency = (value: number | null) => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number | null) => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US').format(value);
  };

  const formatPercent = (value: number | null) => {
    if (value === null) return '—';
    return `${value.toFixed(1)}%`;
  };

  return (
    <Card withBorder p="md">
      <Title order={5} mb="md">Summary Statistics</Title>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="md">
        <div>
          <Text size="sm" c="dimmed">Occupied</Text>
          <Text size="lg" fw={600}>{stats.occupiedUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Vacant</Text>
          <Text size="lg" fw={600}>{stats.vacantUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Notice</Text>
          <Text size="lg" fw={600}>{stats.noticeUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Model</Text>
          <Text size="lg" fw={600}>{stats.modelUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Down</Text>
          <Text size="lg" fw={600}>{stats.downUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Applicant</Text>
          <Text size="lg" fw={600}>{stats.applicantUnits}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Physical Occupancy</Text>
          <Text size="lg" fw={600} c={stats.physicalOccupancy && stats.physicalOccupancy >= 90 ? 'green' : 'orange'}>
            {formatPercent(stats.physicalOccupancy)}
          </Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Total Sqft</Text>
          <Text size="lg" fw={600}>{formatNumber(stats.totalSqft)}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Total Monthly Rent</Text>
          <Text size="lg" fw={600}>{formatCurrency(stats.totalMonthlyRent)}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Avg Rent</Text>
          <Text size="lg" fw={600}>{formatCurrency(stats.averageRent)}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Avg Sqft</Text>
          <Text size="lg" fw={600}>{formatNumber(stats.averageSqft)}</Text>
        </div>
        <div>
          <Text size="sm" c="dimmed">Avg Rent/Sqft</Text>
          <Text size="lg" fw={600}>
            {stats.averageRentPerSqft !== null ? `$${stats.averageRentPerSqft.toFixed(2)}` : '—'}
          </Text>
        </div>
      </SimpleGrid>
    </Card>
  );
}

export default function ExtractionPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [extraction, setExtraction] = useState<RentRollExtraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [units, setUnits] = useState<MVPUnit[]>([]);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newUnit, setNewUnit] = useState<Partial<MVPUnit>>({
    unitNumber: '',
    status: 'vacant',
    monthlyRent: null,
    tenantName: null,
    unitType: null,
    unitSqft: null,
    moveInDate: null,
    moveOutDate: null,
    leaseStartDate: null,
    leaseEndDate: null,
    leaseStatus: null,
  });

  const fetchExtraction = useCallback(async () => {
    try {
      const response = await fetch(`/api/extraction/${id}`);
      if (response.ok) {
        const data = await response.json();
        setExtraction(data);
        setUnits(data.units);
      } else {
        notifications.show({
          title: 'Error',
          message: 'Extraction not found',
          color: 'red',
        });
        router.push('/');
      }
    } catch (error) {
      console.error('Error fetching extraction:', error);
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    fetchExtraction();
  }, [fetchExtraction]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/extraction/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units }),
      });

      if (response.ok) {
        const updated = await response.json();
        setExtraction(updated);
        notifications.show({
          title: 'Saved',
          message: 'Changes saved successfully',
          color: 'green',
        });
      }
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: 'Failed to save changes',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/extraction/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units, status: 'approved' }),
      });

      if (response.ok) {
        const updated = await response.json();
        setExtraction(updated);
        notifications.show({
          title: 'Approved',
          message: 'Extraction approved successfully',
          color: 'green',
        });
      }
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: 'Failed to approve extraction',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleExportJSON = () => {
    if (!extraction) return;

    const exportData = {
      ...extraction,
      units,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${extraction.fileName.replace(/\.[^/.]+$/, '')}_extracted.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = () => {
    if (!extraction) return;
    // Trigger download via the API route
    window.location.href = `/api/extraction/${id}/export`;
  };

  const handleUnitChange = useCallback((index: number, field: keyof MVPUnit, value: unknown) => {
    setUnits(prevUnits => {
      const newUnits = [...prevUnits];
      newUnits[index] = { ...newUnits[index], [field]: value };
      return newUnits;
    });
  }, []);

  const handleDeleteUnit = useCallback((index: number) => {
    setUnits(prevUnits => prevUnits.filter((_, i) => i !== index));
  }, []);

  // AG Grid column definitions
  const columnDefs = useMemo<ColDef<MVPUnit>[]>(() => [
    {
      field: 'unitNumber',
      headerName: 'Unit #',
      width: 100,
      editable: true,
      pinned: 'left',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      editable: true,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: {
        values: ['occupied', 'vacant', 'notice', 'model', 'down', 'applicant'],
      },
      cellStyle: (params) => {
        const colors: Record<string, string> = {
          occupied: '#d3f9d8',
          vacant: '#ffe3e3',
          notice: '#fff3bf',
          model: '#d0ebff',
          down: '#e9ecef',
          applicant: '#e5dbff',
        };
        return { backgroundColor: colors[params.value] || 'transparent' };
      },
    },
    {
      field: 'unitType',
      headerName: 'Type',
      width: 100,
      editable: true,
    },
    {
      field: 'unitSqft',
      headerName: 'Sqft',
      width: 80,
      editable: true,
      type: 'numericColumn',
      valueParser: (params) => {
        const val = Number(params.newValue);
        return isNaN(val) ? null : val;
      },
    },
    {
      field: 'monthlyRent',
      headerName: 'Rent',
      width: 100,
      editable: true,
      type: 'numericColumn',
      valueFormatter: (params) => {
        if (params.value == null) return '';
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 0,
        }).format(params.value);
      },
      valueParser: (params) => {
        const val = Number(String(params.newValue).replace(/[$,]/g, ''));
        return isNaN(val) ? null : val;
      },
    },
    {
      field: 'tenantName',
      headerName: 'Tenant',
      width: 180,
      editable: true,
    },
    {
      field: 'leaseStartDate',
      headerName: 'Lease Start',
      width: 110,
      editable: true,
    },
    {
      field: 'leaseEndDate',
      headerName: 'Lease End',
      width: 110,
      editable: true,
    },
    {
      field: 'moveInDate',
      headerName: 'Move In',
      width: 110,
      editable: true,
    },
    {
      field: 'moveOutDate',
      headerName: 'Move Out',
      width: 110,
      editable: true,
    },
    {
      field: 'leaseStatus',
      headerName: 'Lease Status',
      width: 120,
      editable: true,
    },
    {
      headerName: '',
      width: 50,
      pinned: 'right',
      cellRenderer: (params: { node: { rowIndex: number | null } }) => {
        const rowIndex = params.node.rowIndex;
        if (rowIndex === null) return null;
        return (
          <ActionIcon
            color="red"
            variant="subtle"
            size="sm"
            onClick={() => handleDeleteUnit(rowIndex)}
          >
            <IconTrash size={14} />
          </ActionIcon>
        );
      },
      sortable: false,
      filter: false,
    },
  ], [handleDeleteUnit]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
  }), []);

  const onCellValueChanged = useCallback((event: CellValueChangedEvent<MVPUnit>) => {
    const { rowIndex, colDef, newValue } = event;
    if (rowIndex !== null && colDef.field) {
      handleUnitChange(rowIndex, colDef.field as keyof MVPUnit, newValue);
    }
  }, [handleUnitChange]);

  const handleAddUnit = () => {
    if (!newUnit.unitNumber) {
      notifications.show({
        title: 'Error',
        message: 'Unit number is required',
        color: 'red',
      });
      return;
    }

    setUnits([...units, newUnit as MVPUnit]);
    setNewUnit({
      unitNumber: '',
      status: 'vacant',
      monthlyRent: null,
      tenantName: null,
      unitType: null,
      unitSqft: null,
      moveInDate: null,
      moveOutDate: null,
      leaseStartDate: null,
      leaseEndDate: null,
      leaseStatus: null,
    });
    setAddModalOpen(false);
  };

  if (loading) {
    return (
      <Container size="xl" py="xl">
        <Group justify="center" py="xl">
          <Loader size="lg" />
        </Group>
      </Container>
    );
  }

  if (!extraction) {
    return (
      <Container size="xl" py="xl">
        <Text>Extraction not found</Text>
      </Container>
    );
  }

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        {/* Header */}
        <Group justify="space-between">
          <Group>
            <ActionIcon variant="subtle" onClick={() => router.push('/')}>
              <IconArrowLeft size={20} />
            </ActionIcon>
            <div>
              <Title order={2}>{extraction.fileName}</Title>
              <Text c="dimmed" size="sm">
                {extraction.propertyName || 'Unknown Property'} • {extraction.sourceType.toUpperCase()} • {extraction.sourceFormat || 'Unknown format'}
              </Text>
            </div>
          </Group>
          <Group>
            <Button
              variant="outline"
              leftSection={<IconDownload size={16} />}
              onClick={handleExportExcel}
            >
              Export Excel
            </Button>
            <Button
              variant="outline"
              leftSection={<IconDownload size={16} />}
              onClick={handleExportJSON}
            >
              Export JSON
            </Button>
            <Button
              variant="outline"
              onClick={handleSave}
              loading={saving}
            >
              Save Changes
            </Button>
            <Button
              color="green"
              leftSection={<IconCheck size={16} />}
              onClick={handleApprove}
              loading={saving}
              disabled={extraction.status === 'approved'}
            >
              {extraction.status === 'approved' ? 'Approved' : 'Approve'}
            </Button>
          </Group>
        </Group>

        {/* Unit Count Card */}
        <UnitCountCard extraction={{ ...extraction, extractedUnitCount: units.length }} />

        {/* Summary Statistics */}
        <SummaryStatsCard stats={extraction.summaryStats} />

        {/* Validation Issues */}
        <Paper withBorder p="md">
          <Title order={4} mb="md">Validation Issues</Title>
          <ValidationIssuesList issues={extraction.validationIssues} />
        </Paper>

        {/* Units Table */}
        <Paper withBorder p="md">
          <Group justify="space-between" mb="md">
            <Title order={4}>Units ({units.length})</Title>
            <Button
              size="sm"
              leftSection={<IconPlus size={16} />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Unit
            </Button>
          </Group>

          <div style={{ height: 600, width: '100%' }}>
            <AgGridReact
              theme={themeQuartz}
              rowData={units}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              onCellValueChanged={onCellValueChanged}
              rowSelection="multiple"
              suppressRowClickSelection={true}
              animateRows={false}
              getRowId={(params) => String(params.data.unitNumber)}
            />
          </div>
        </Paper>
      </Stack>

      {/* Add Unit Modal */}
      <Modal
        opened={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title="Add Unit"
        size="lg"
      >
        <Stack>
          <SimpleGrid cols={2}>
            <TextInput
              label="Unit Number"
              required
              value={newUnit.unitNumber}
              onChange={(e) => setNewUnit({ ...newUnit, unitNumber: e.target.value })}
            />
            <Select
              label="Status"
              value={newUnit.status}
              data={STATUS_OPTIONS}
              onChange={(value) => setNewUnit({ ...newUnit, status: value as UnitStatus })}
            />
            <TextInput
              label="Unit Type"
              value={newUnit.unitType ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, unitType: e.target.value || null })}
              placeholder="e.g., 1BR/1BA"
            />
            <NumberInput
              label="Sqft"
              value={newUnit.unitSqft ?? ''}
              onChange={(value) => setNewUnit({ ...newUnit, unitSqft: value as number || null })}
            />
            <NumberInput
              label="Monthly Rent"
              value={newUnit.monthlyRent ?? ''}
              onChange={(value) => setNewUnit({ ...newUnit, monthlyRent: value as number || null })}
              prefix="$"
              thousandSeparator=","
            />
            <TextInput
              label="Tenant Name"
              value={newUnit.tenantName ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, tenantName: e.target.value || null })}
            />
            <TextInput
              label="Move In Date"
              value={newUnit.moveInDate ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, moveInDate: e.target.value || null })}
              placeholder="YYYY-MM-DD"
            />
            <TextInput
              label="Move Out Date"
              value={newUnit.moveOutDate ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, moveOutDate: e.target.value || null })}
              placeholder="YYYY-MM-DD"
            />
            <TextInput
              label="Lease Start"
              value={newUnit.leaseStartDate ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, leaseStartDate: e.target.value || null })}
              placeholder="YYYY-MM-DD"
            />
            <TextInput
              label="Lease End"
              value={newUnit.leaseEndDate ?? ''}
              onChange={(e) => setNewUnit({ ...newUnit, leaseEndDate: e.target.value || null })}
              placeholder="YYYY-MM-DD"
            />
          </SimpleGrid>
          <Button onClick={handleAddUnit}>Add Unit</Button>
        </Stack>
      </Modal>
    </Container>
  );
}
