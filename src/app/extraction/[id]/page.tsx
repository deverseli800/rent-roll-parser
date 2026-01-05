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
  Collapse,
  UnstyledButton,
  Switch,
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
  IconX,
  IconMinus,
  IconShieldCheck,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import type { ColDef, CellValueChangedEvent } from 'ag-grid-community';
import type { RentRollExtraction, MVPUnit, UnitStatus, ValidationIssue, SummaryStats, StatedSummaryStats, VerificationSummary } from '@/lib/types';

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

function VerificationChecksCard({ summary }: { summary: VerificationSummary | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!summary) {
    return null;
  }

  const confidenceColors = {
    high: 'green',
    medium: 'yellow',
    low: 'red',
  };

  const confidenceLabels = {
    high: 'High Confidence',
    medium: 'Medium Confidence',
    low: 'Low Confidence',
  };

  const statusIcon = (status: 'passed' | 'failed' | 'skipped') => {
    switch (status) {
      case 'passed':
        return <IconCircleCheck size={18} color="var(--mantine-color-green-6)" />;
      case 'failed':
        return <IconX size={18} color="var(--mantine-color-red-6)" />;
      case 'skipped':
        return <IconMinus size={18} color="var(--mantine-color-gray-5)" />;
    }
  };

  const statusColor = (status: 'passed' | 'failed' | 'skipped') => {
    switch (status) {
      case 'passed': return 'green';
      case 'failed': return 'red';
      case 'skipped': return 'gray';
    }
  };

  return (
    <Card withBorder p="md">
      <UnstyledButton
        onClick={() => setExpanded(!expanded)}
        style={{ width: '100%' }}
      >
        <Group justify="space-between">
          <Group gap="sm">
            {expanded ? <IconChevronDown size={20} /> : <IconChevronRight size={20} />}
            <IconShieldCheck size={24} />
            <Title order={5}>Verification Checks</Title>
          </Group>
          <Group gap="md">
            <Text size="sm" c="dimmed">
              {summary.passed}/{summary.total - summary.skipped} passed
              {summary.skipped > 0 && ` (${summary.skipped} skipped)`}
            </Text>
            <Badge
              size="lg"
              color={confidenceColors[summary.confidence]}
              variant="light"
            >
              {confidenceLabels[summary.confidence]}
            </Badge>
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Stack gap="xs" mt="md">
          {summary.checks.map((check) => (
            <Paper
              key={check.id}
              withBorder
              p="sm"
              style={{
                borderLeftWidth: 3,
                borderLeftColor: `var(--mantine-color-${statusColor(check.status)}-${check.status === 'skipped' ? '3' : '6'})`,
              }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  {statusIcon(check.status)}
                  <div>
                    <Text size="sm" fw={500}>{check.name}</Text>
                    <Text size="xs" c="dimmed">{check.description}</Text>
                  </div>
                </Group>
                {check.details && (
                  <Text
                    size="xs"
                    c={check.status === 'passed' ? 'green' : check.status === 'failed' ? 'red' : 'dimmed'}
                    style={{ textAlign: 'right', maxWidth: '40%' }}
                  >
                    {check.details}
                  </Text>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      </Collapse>
    </Card>
  );
}

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

function ComparisonValue({
  label,
  stated,
  calculated,
  format = 'number',
  tolerancePercent = 1
}: {
  label: string;
  stated: number | null;
  calculated: number | null;
  format?: 'number' | 'currency' | 'percent';
  tolerancePercent?: number;
}) {
  const formatValue = (value: number | null) => {
    if (value === null) return '—';
    if (format === 'currency') {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value);
    }
    if (format === 'percent') {
      return `${value.toFixed(1)}%`;
    }
    return new Intl.NumberFormat('en-US').format(value);
  };

  const hasStated = stated !== null;
  const hasCalculated = calculated !== null;

  // Check if values match within tolerance
  let isMatch = true;
  if (hasStated && hasCalculated) {
    const diff = Math.abs(stated - calculated);
    const tolerance = stated * (tolerancePercent / 100);
    isMatch = diff <= tolerance || diff < 1; // Also ignore differences under 1
  }

  return (
    <div>
      <Text size="sm" c="dimmed">{label}</Text>
      {hasStated ? (
        <Group gap="xs" align="baseline">
          <div>
            <Text size="xs" c="dimmed" mb={2}>Stated</Text>
            <Text size="lg" fw={600}>{formatValue(stated)}</Text>
          </div>
          <Text size="lg" c="dimmed">/</Text>
          <div>
            <Text size="xs" c="dimmed" mb={2}>Calculated</Text>
            <Text size="lg" fw={600} c={isMatch ? undefined : 'orange'}>
              {formatValue(calculated)}
              {!isMatch && hasCalculated && (
                <IconAlertTriangle
                  size={14}
                  style={{ marginLeft: 4, verticalAlign: 'middle' }}
                  color="var(--mantine-color-orange-6)"
                />
              )}
            </Text>
          </div>
        </Group>
      ) : (
        <Text size="lg" fw={600}>{formatValue(calculated)}</Text>
      )}
    </div>
  );
}

function SummaryStatsCard({
  stats,
  statedStats
}: {
  stats: SummaryStats | null;
  statedStats?: StatedSummaryStats | null;
}) {
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

  const hasStatedStats = statedStats && (
    statedStats.totalMonthlyRent !== null ||
    statedStats.totalSqft !== null ||
    statedStats.occupancyRate !== null ||
    statedStats.occupiedUnits !== null ||
    statedStats.vacantUnits !== null
  );

  return (
    <Card withBorder p="md">
      <Group justify="space-between" mb="md">
        <Title order={5}>Summary Statistics</Title>
        {hasStatedStats && (
          <Badge color="blue" variant="light">
            Stated values available
          </Badge>
        )}
      </Group>

      {/* Comparison metrics (stated vs calculated when available) */}
      {hasStatedStats && (
        <>
          <Text size="sm" c="dimmed" mb="sm" fw={500}>Stated vs Calculated Comparison</Text>
          <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="md" mb="lg">
            <ComparisonValue
              label="Total Monthly Rent"
              stated={statedStats?.totalMonthlyRent ?? null}
              calculated={stats.totalMonthlyRent}
              format="currency"
            />
            <ComparisonValue
              label="Total Sqft"
              stated={statedStats?.totalSqft ?? null}
              calculated={stats.totalSqft}
            />
            <ComparisonValue
              label="Occupancy Rate"
              stated={statedStats?.occupancyRate ?? null}
              calculated={stats.physicalOccupancy}
              format="percent"
            />
            <ComparisonValue
              label="Occupied Units"
              stated={statedStats?.occupiedUnits ?? null}
              calculated={stats.occupiedUnits}
              tolerancePercent={0}
            />
            <ComparisonValue
              label="Vacant Units"
              stated={statedStats?.vacantUnits ?? null}
              calculated={stats.vacantUnits}
              tolerancePercent={0}
            />
          </SimpleGrid>
        </>
      )}

      {/* Regular calculated stats */}
      <Text size="sm" c="dimmed" mb="sm" fw={500}>{hasStatedStats ? 'Full Breakdown (Calculated)' : 'Calculated Values'}</Text>
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
  const [showAllColumns, setShowAllColumns] = useState(false);
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

  // Detect which optional columns have data
  const columnsWithData = useMemo(() => {
    const optionalFields = ['unitType', 'unitSqft', 'tenantName', 'leaseStartDate', 'leaseEndDate', 'moveInDate', 'moveOutDate', 'leaseStatus'] as const;
    const hasData: Record<string, boolean> = {};

    for (const field of optionalFields) {
      hasData[field] = units.some(unit => unit[field] !== null && unit[field] !== undefined && unit[field] !== '');
    }

    return hasData;
  }, [units]);

  // AG Grid column definitions
  const columnDefs = useMemo<ColDef<MVPUnit>[]>(() => {
    const allColumns: (ColDef<MVPUnit> & { field?: string })[] = [
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
        width: 120,
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
        width: 120,
        editable: true,
      },
      {
        field: 'leaseEndDate',
        headerName: 'Lease End',
        width: 120,
        editable: true,
      },
      {
        field: 'moveInDate',
        headerName: 'Move In',
        width: 120,
        editable: true,
      },
      {
        field: 'moveOutDate',
        headerName: 'Move Out',
        width: 120,
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
        width: 70,
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
    ];

    // Always show: unitNumber, status, monthlyRent, and delete button
    const alwaysShowFields = ['unitNumber', 'status', 'monthlyRent', undefined]; // undefined = delete column

    if (showAllColumns) {
      return allColumns;
    }

    // Filter to only show columns with data
    const filteredColumns = allColumns.filter(col => {
      if (alwaysShowFields.includes(col.field)) return true;
      if (!col.field) return true; // Keep columns without field (like delete)
      return columnsWithData[col.field];
    });

    // Make the last data column (before delete) flex to fill remaining space
    const lastDataIndex = filteredColumns.length - 2; // -1 for delete, -1 for 0-index
    if (lastDataIndex >= 0 && filteredColumns[lastDataIndex]) {
      filteredColumns[lastDataIndex] = {
        ...filteredColumns[lastDataIndex],
        flex: 1,
        minWidth: filteredColumns[lastDataIndex].width || 100,
      };
    }

    return filteredColumns;
  }, [handleDeleteUnit, showAllColumns, columnsWithData]);

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
    <Container fluid px="xl" py="xl">
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

        {/* Verification Checks */}
        <VerificationChecksCard summary={extraction.verificationSummary} />

        {/* Summary Statistics */}
        <SummaryStatsCard stats={extraction.summaryStats} statedStats={extraction.statedSummaryStats} />

        {/* Validation Issues */}
        <Paper withBorder p="md">
          <Title order={4} mb="md">Validation Issues</Title>
          <ValidationIssuesList issues={extraction.validationIssues} />
        </Paper>

        {/* Units Table */}
        <Paper withBorder p="md">
          <Group justify="space-between" mb="md">
            <Title order={4}>Units ({units.length})</Title>
            <Group gap="md">
              <Switch
                label="Show all columns"
                checked={showAllColumns}
                onChange={(e) => setShowAllColumns(e.currentTarget.checked)}
                size="sm"
              />
              <Button
                size="sm"
                leftSection={<IconPlus size={16} />}
                onClick={() => setAddModalOpen(true)}
              >
                Add Unit
              </Button>
            </Group>
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
