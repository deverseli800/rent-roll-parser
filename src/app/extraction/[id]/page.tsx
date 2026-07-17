'use client';

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
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
  Tooltip,
  Timeline,
  ThemeIcon,
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
  IconBulb,
  IconSparkles,
  IconKeyboard,
  IconBolt,
  IconCpu,
  IconStairsUp,
  IconArrowsSplit,
  IconInfoCircle,
  IconListDetails,
} from '@tabler/icons-react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import type { ColDef, CellValueChangedEvent, GridApi } from 'ag-grid-community';
import type { RentRollExtraction, GenericRentRollUnit, UnitStatus, ValidationIssue, SummaryStats, StatedSummaryStats, VerificationSummary, ExplanationSummary, ProgressEvent } from '@/lib/types';
import { getExtraction, saveExtraction, updateExtraction as updateStoredExtraction } from '@/lib/clientStorage';
import { detectHighlights, getHighlightSummary, type UnitHighlights, type CellHighlight } from '@/lib/utils/outlierDetection';
import { calculateSummaryStats, nonTenantRentFromUnits } from '@/lib/utils/summaryStats';
import { normalizeOccupancyRatePct, reconcileOccupiedCount, reconcileTotalRent, reconcileVacantCount } from '@/lib/utils/occupancy';
import { modelLabel } from '@/lib/utils/modelLabels';
import { formatUSD } from '@/lib/utils/aiCost';
import * as XLSX from 'xlsx';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

// Shared cell formatting for currency columns (rent components)
const currencyFormatter = (params: { value?: number | null }) => {
  if (params.value == null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(params.value);
};
const currencyParser = (params: { newValue?: unknown }) => {
  const val = Number(String(params.newValue).replace(/[$,]/g, ''));
  return isNaN(val) ? null : val;
};

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
            <Tooltip
              label={summary.confidenceReason}
              multiline
              w={300}
              withArrow
              position="bottom"
            >
              <Badge
                size="lg"
                color={confidenceColors[summary.confidence]}
                variant="light"
                style={{ cursor: 'help' }}
              >
                {confidenceLabels[summary.confidence]}
              </Badge>
            </Tooltip>
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

function ExplanationsCard({ summary }: { summary: ExplanationSummary | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!summary || !summary.hasExplanations || summary.explanations.length === 0) {
    return null;
  }

  const rootCauseLabels: Record<string, { label: string; color: string }> = {
    category_mismatch: { label: 'Category Definition', color: 'blue' },
    extraction_error: { label: 'Extraction Error', color: 'red' },
    data_quality: { label: 'Data Quality', color: 'orange' },
    unknown: { label: 'Unknown', color: 'gray' },
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
            <IconBulb size={24} color="var(--mantine-color-yellow-6)" />
            <Title order={5}>Mismatch Explanations</Title>
          </Group>
          <Badge size="lg" color="blue" variant="light">
            {summary.explanations.length} explanation{summary.explanations.length !== 1 ? 's' : ''}
          </Badge>
        </Group>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Stack gap="md" mt="md">
          {/* Overall Assessment */}
          <Alert color="blue" variant="light" icon={<IconBulb size={18} />}>
            {summary.overallAssessment}
          </Alert>

          {/* Individual Explanations */}
          {summary.explanations.map((explanation, index) => {
            const causeInfo = rootCauseLabels[explanation.rootCause] || rootCauseLabels.unknown;

            return (
              <Paper
                key={index}
                withBorder
                p="md"
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: `var(--mantine-color-${causeInfo.color}-6)`,
                }}
              >
                <Group justify="space-between" mb="xs">
                  <Text fw={600}>{explanation.checkName}</Text>
                  <Badge color={causeInfo.color} variant="light" size="sm">
                    {causeInfo.label}
                  </Badge>
                </Group>

                <Text size="sm" mb="sm">{explanation.explanation}</Text>

                {explanation.affectedUnits && explanation.affectedUnits.length > 0 && (
                  <Group gap="xs" mb="xs">
                    <Text size="xs" c="dimmed">Affected units:</Text>
                    {explanation.affectedUnits.slice(0, 10).map((unit) => (
                      <Badge key={unit} size="xs" variant="outline" color="gray">
                        {unit}
                      </Badge>
                    ))}
                    {explanation.affectedUnits.length > 10 && (
                      <Text size="xs" c="dimmed">
                        +{explanation.affectedUnits.length - 10} more
                      </Text>
                    )}
                  </Group>
                )}

                {explanation.recommendation && (
                  <Text size="sm" c="dimmed" fs="italic">
                    💡 {explanation.recommendation}
                  </Text>
                )}
              </Paper>
            );
          })}
        </Stack>
      </Collapse>
    </Card>
  );
}

function ValidationIssuesCard({ issues }: { issues: ValidationIssue[] }) {
  const [expanded, setExpanded] = useState(false);

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;

  const getBadgeColor = () => {
    if (criticalCount > 0) return 'red';
    if (warningCount > 0) return 'yellow';
    return 'green';
  };

  const getBadgeText = () => {
    if (issues.length === 0) return 'No Issues';
    if (criticalCount > 0) return `${criticalCount} Critical`;
    if (warningCount > 0) return `${warningCount} Warning${warningCount > 1 ? 's' : ''}`;
    return `${issues.length} Info`;
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
            <IconAlertTriangle size={24} color={issues.length > 0 ? 'var(--mantine-color-orange-6)' : 'var(--mantine-color-gray-5)'} />
            <Title order={5}>Validation Issues</Title>
          </Group>
          <Badge
            size="lg"
            color={getBadgeColor()}
            variant="light"
          >
            {getBadgeText()}
          </Badge>
        </Group>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Stack gap="xs" mt="md">
          {issues.length === 0 ? (
            <Alert icon={<IconCircleCheck size={16} />} color="green" variant="light">
              No validation issues found
            </Alert>
          ) : (
            issues.map((issue, index) => (
              <Alert
                key={index}
                icon={<IconAlertTriangle size={16} />}
                color={issue.severity === 'critical' ? 'red' : issue.severity === 'warning' ? 'yellow' : 'blue'}
                variant="light"
                title={issue.type.replace('_', ' ').toUpperCase()}
              >
                {issue.message}
              </Alert>
            ))
          )}
        </Stack>
      </Collapse>
    </Card>
  );
}

function formatModelName(model: string | null): string {
  if (!model) return '—';
  return modelLabel(model);
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
        <div>
          <Text size="sm" c="dimmed">Est. API Cost</Text>
          <Text size="lg" fw={600}>{formatUSD(extraction.costUSD)}</Text>
        </div>
      </Group>
    </Card>
  );
}

const EVENT_STYLE: Record<ProgressEvent['kind'], { color: string; icon: ReactNode }> = {
  info:        { color: 'gray',   icon: <IconInfoCircle size={13} /> },
  fastpath:    { color: 'blue',   icon: <IconBolt size={13} /> },
  preview:     { color: 'teal',   icon: <IconSparkles size={13} /> },
  attempt:     { color: 'blue',   icon: <IconCpu size={13} /> },
  verify_pass: { color: 'green',  icon: <IconCircleCheck size={13} /> },
  verify_fail: { color: 'red',    icon: <IconAlertTriangle size={13} /> },
  escalation:  { color: 'orange', icon: <IconStairsUp size={13} /> },
  decision:    { color: 'violet', icon: <IconArrowsSplit size={13} /> },
};

/**
 * Timeline of extraction pipeline events. Live view renders newest-first
 * (console style — the latest event is always visible without scrolling);
 * the post-completion log reads chronologically.
 */
function ExtractionTimeline({ events, newestFirst = false }: { events: ProgressEvent[]; newestFirst?: boolean }) {
  if (events.length === 0) return null;

  const ordered = newestFirst ? [...events].reverse() : events;
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  return (
    <Timeline active={ordered.length - 1} bulletSize={22} lineWidth={2}>
      {ordered.map((event, i) => {
        const style = EVENT_STYLE[event.kind] ?? EVENT_STYLE.info;
        const isEscalation = event.kind === 'escalation';
        return (
          <Timeline.Item
            key={`${event.at}-${i}`}
            bullet={
              <ThemeIcon size={22} radius="xl" color={style.color} variant={isEscalation ? 'filled' : 'light'}>
                {style.icon}
              </ThemeIcon>
            }
          >
            <Group gap="sm" align="baseline" wrap="nowrap">
              <Text size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: 'nowrap' }}>{fmtTime(event.at)}</Text>
              <Text size="sm" fw={isEscalation ? 600 : undefined} c={isEscalation ? 'orange.8' : undefined}>
                {event.message}
              </Text>
            </Group>
          </Timeline.Item>
        );
      })}
    </Timeline>
  );
}

// The pipeline's real phases — the stage rail encodes actual structure,
// mapping the reporter's fine-grained stages onto four user-facing steps.
const PHASES = ['Read', 'Analyze', 'Extract', 'Verify'] as const;

function phaseIndex(stage: string): number {
  switch (stage) {
    case 'queued':
    case 'reading': return 0;
    case 'triaging':
    case 'mapping': return 1;
    case 'extracting':
    case 'verifying':
    case 'escalating':
    case 'merging': return 2;
    case 'validating':
    case 'explaining': return 3;
    default: return 2;
  }
}

const STAGE_TITLES: Record<string, string> = {
  queued: 'Queued',
  reading: 'Reading workbook',
  triaging: 'Choosing sheets',
  mapping: 'Analyzing structure',
  extracting: 'Extracting units',
  verifying: 'Verifying results',
  escalating: 'Escalating model',
  merging: 'Merging sheets',
  validating: 'Running checks',
  explaining: 'Explaining findings',
};

/** Horizontal Read → Analyze → Extract → Verify rail with the current phase lit. */
function StageRail({ stage }: { stage: string }) {
  const current = phaseIndex(stage);
  return (
    <Group gap={0} wrap="nowrap" style={{ width: '100%' }}>
      {PHASES.map((label, i) => (
        <Group key={label} gap={6} wrap="nowrap" style={{ flex: i < PHASES.length - 1 ? 1 : undefined }}>
          <div
            style={{
              width: 10, height: 10, borderRadius: 5, flexShrink: 0,
              background: i < current
                ? 'var(--mantine-color-teal-6)'
                : i === current
                  ? 'var(--mantine-color-teal-6)'
                  : 'var(--mantine-color-gray-3)',
              boxShadow: i === current ? '0 0 0 4px var(--mantine-color-teal-1)' : undefined,
            }}
          />
          <Text
            size="xs"
            fw={i === current ? 700 : 500}
            c={i < current ? 'teal.7' : i === current ? 'teal.8' : 'dimmed'}
            style={{ whiteSpace: 'nowrap' }}
          >
            {label}
          </Text>
          {i < PHASES.length - 1 && (
            <div
              style={{
                flex: 1, height: 2, margin: '0 10px', borderRadius: 1,
                background: i < current ? 'var(--mantine-color-teal-4)' : 'var(--mantine-color-gray-3)',
              }}
            />
          )}
        </Group>
      ))}
    </Group>
  );
}

/**
 * The document's own stated totals, read by a quick first AI pass and written
 * to the record within seconds of upload — shown while the full unit-level
 * extraction (minutes for large documents) is still running.
 */
function StatedPreviewCard({ extraction }: { extraction: RentRollExtraction }) {
  const s = extraction.statedSummaryStats;
  const unitCount = extraction.statedUnitCount ?? s?.totalUnits ?? null;
  if (!s && unitCount === null) return null;

  const stats: { label: string; value: string }[] = [];
  if (unitCount !== null) stats.push({ label: 'Total Units', value: unitCount.toLocaleString('en-US') });
  if (s?.occupancyRate != null) stats.push({ label: 'Occupancy', value: `${s.occupancyRate.toFixed(1)}%` });
  if (s?.occupiedUnits != null) stats.push({ label: 'Occupied', value: s.occupiedUnits.toLocaleString('en-US') });
  if (s?.vacantUnits != null) stats.push({ label: 'Vacant', value: s.vacantUnits.toLocaleString('en-US') });
  if (s?.totalMonthlyRent != null) stats.push({ label: 'Monthly Rent', value: `$${Math.round(s.totalMonthlyRent).toLocaleString('en-US')}` });
  if (s?.totalSqft != null) stats.push({ label: 'Total Sqft', value: Math.round(s.totalSqft).toLocaleString('en-US') });
  if (stats.length === 0) return null;

  return (
    <Paper withBorder radius="lg" p="md">
      <Group gap="xs" mb="sm">
        <IconSparkles size={18} color="var(--mantine-color-teal-6)" />
        <Text fw={600} size="sm">
          From the document&apos;s summary{extraction.propertyName ? ` — ${extraction.propertyName}` : ''}
        </Text>
        <Badge size="xs" color="teal" variant="light">quick first pass</Badge>
      </Group>
      <SimpleGrid cols={{ base: 3, sm: Math.min(stats.length, 6) }} spacing="md">
        {stats.map(({ label, value }) => (
          <div key={label}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Text size="lg" fw={700}>{value}</Text>
          </div>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="sm">
        These are the totals the document states about itself — each unit is now being extracted and will be verified against them.
      </Text>
    </Paper>
  );
}

/**
 * Live extraction console: compact status header (pulsing dot, phase, ticking
 * elapsed), pipeline stage rail, then the newest-first event feed as the
 * dominant element — the latest event is always visible without scrolling.
 */
function ProcessingView({ extraction, onBack }: { extraction: RentRollExtraction; onBack: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const stage = extraction.progress?.stage ?? 'queued';
  const isEscalating = stage === 'escalating';
  const accent = isEscalating ? 'orange' : 'teal';
  const events = extraction.progress?.events ?? [];

  const elapsedMs = Math.max(0, now - new Date(extraction.uploadedAt).getTime());
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);

  return (
    <Container size="md" py="xl">
      <style>{`
        .rrp-pulse { animation: rrp-pulse 1.6s ease-in-out infinite; }
        @keyframes rrp-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--mantine-color-${accent}-3); }
          50% { opacity: 0.7; box-shadow: 0 0 0 6px transparent; }
        }
        @media (prefers-reduced-motion: reduce) { .rrp-pulse { animation: none; } }
      `}</style>
      <Stack gap="lg">
        <Group>
          <ActionIcon variant="subtle" onClick={onBack}>
            <IconArrowLeft size={20} />
          </ActionIcon>
          <div>
            <Title order={2}>{extraction.fileName}</Title>
            <Text c="dimmed" size="sm">Extraction in progress — you can leave; processing continues on the server</Text>
          </div>
        </Group>

        {/* Stated totals from the quick first pass, while units extract */}
        <StatedPreviewCard extraction={extraction} />

        <Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
          {/* Live status header */}
          <div style={{ padding: '20px 24px', background: `var(--mantine-color-${accent}-0)` }}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                <span
                  className="rrp-pulse"
                  style={{
                    width: 12, height: 12, borderRadius: 6, marginTop: 6, flexShrink: 0,
                    background: `var(--mantine-color-${accent}-6)`,
                  }}
                />
                <div>
                  <Text fw={700} size="lg" c={`${accent}.9`}>
                    {STAGE_TITLES[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1)}
                  </Text>
                  {extraction.progress?.detail && (
                    <Text size="sm" c="dimmed">{extraction.progress.detail}</Text>
                  )}
                </div>
              </Group>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <Text size="lg" fw={700} ff="monospace" c={`${accent}.9`}>
                  {elapsedMin > 0 ? `${elapsedMin}m ${String(elapsedSec).padStart(2, '0')}s` : `${elapsedSec}s`}
                </Text>
                <Text size="xs" c="dimmed">large docs: 5–25 min</Text>
              </div>
            </Group>
            <div style={{ marginTop: 18 }}>
              <StageRail stage={stage} />
            </div>
          </div>

          {/* Newest-first live feed — the main content */}
          <div style={{ padding: '20px 24px' }}>
            {events.length > 0 ? (
              <ExtractionTimeline events={events} newestFirst />
            ) : (
              <Group gap="sm">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">Starting up…</Text>
              </Group>
            )}
          </div>
        </Paper>
      </Stack>
    </Container>
  );
}

/** Collapsible post-completion card: how the extraction ran (models, escalations). */
function ExtractionLogCard({ log, modelUsed }: { log: ProgressEvent[] | null | undefined; modelUsed: string | null }) {
  const [opened, setOpened] = useState(false);
  if (!log || log.length === 0) return null;

  const escalated = log.some(e => e.kind === 'escalation');
  const fastPath = log.some(e => e.kind === 'fastpath' && e.message.includes('succeeded'));

  return (
    <Card withBorder p="md">
      <UnstyledButton onClick={() => setOpened(o => !o)} style={{ width: '100%' }}>
        <Group justify="space-between">
          <Group gap="xs">
            {opened ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
            <IconListDetails size={20} />
            <Title order={5}>How this was extracted</Title>
          </Group>
          <Group gap="xs">
            {fastPath && (
              <Badge color="blue" variant="light" leftSection={<IconBolt size={12} />}>
                Deterministic fast path
              </Badge>
            )}
            {escalated && (
              <Badge color="orange" variant="light" leftSection={<IconStairsUp size={12} />}>
                Escalated
              </Badge>
            )}
            {modelUsed && (
              <Badge color="gray" variant="light">{modelLabel(modelUsed)}</Badge>
            )}
          </Group>
        </Group>
      </UnstyledButton>
      <Collapse in={opened}>
        <div style={{ marginTop: 16 }}>
          <ExtractionTimeline events={log} />
        </div>
      </Collapse>
    </Card>
  );
}

function ComparisonValue({
  label,
  stated,
  calculated,
  format = 'number',
  tolerancePercent = 1,
  matchOverride,
  note
}: {
  label: string;
  stated: number | null;
  calculated: number | null;
  format?: 'number' | 'currency' | 'percent';
  tolerancePercent?: number;
  /** Overrides the tolerance check (e.g. occupied-count reconciliation) */
  matchOverride?: boolean;
  /** Explains why stated and calculated legitimately differ */
  note?: string;
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
  if (matchOverride !== undefined) {
    isMatch = matchOverride;
  } else if (hasStated && hasCalculated) {
    const diff = Math.abs(stated - calculated);
    const tolerance = stated * (tolerancePercent / 100);
    isMatch = diff <= tolerance || diff < 1; // Also ignore differences under 1
  }

  return (
    <div>
      <Text size="sm" c="dimmed">{label}</Text>
      {hasStated ? (
        <>
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
          {note && (
            <Text size="xs" c={isMatch ? 'teal.7' : 'orange.7'} mt={4} style={{ lineHeight: 1.35 }}>
              {note}
            </Text>
          )}
        </>
      ) : (
        <Text size="lg" fw={600}>{formatValue(calculated)}</Text>
      )}
    </div>
  );
}

function SummaryStatsCard({
  stats,
  statedStats,
  units
}: {
  stats: SummaryStats | null;
  statedStats?: StatedSummaryStats | null;
  units?: GenericRentRollUnit[];
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
    (statedStats.totalMarketRent ?? null) !== null ||
    statedStats.totalSqft !== null ||
    statedStats.occupancyRate !== null ||
    statedStats.occupiedUnits !== null ||
    statedStats.vacantUnits !== null
  );

  // Explain legitimate stated-vs-calculated differences inline so a
  // definitional gap (model-unit rent, notice counted as occupied) doesn't
  // read as an extraction error. nonTenantRent is recomputed live from units
  // when the (possibly cached) summaryStats predates the field.
  const nonTenantRent = stats.nonTenantRent ?? (units ? nonTenantRentFromUnits(units) : null);
  const rentReconciliation =
    statedStats?.totalMonthlyRent != null && stats.totalMonthlyRent != null
      ? reconcileTotalRent(statedStats.totalMonthlyRent, stats.totalMonthlyRent, nonTenantRent)
      : null;
  const statusCounts = {
    occupied: stats.occupiedUnits,
    vacant: stats.vacantUnits,
    notice: stats.noticeUnits,
    model: stats.modelUnits,
    down: stats.downUnits,
    applicant: stats.applicantUnits,
  };
  const occupiedReconciliation =
    statedStats?.occupiedUnits != null
      ? reconcileOccupiedCount(statedStats.occupiedUnits, statusCounts)
      : null;
  const vacantReconciliation =
    statedStats?.vacantUnits != null
      ? reconcileVacantCount(statedStats.vacantUnits, statusCounts)
      : null;

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
              matchOverride={rentReconciliation?.ok}
              note={rentReconciliation && !rentReconciliation.exact ? rentReconciliation.explanation : undefined}
            />
            {(statedStats?.totalMarketRent ?? null) !== null && (
              <ComparisonValue
                label="Total Market Rent"
                stated={statedStats?.totalMarketRent ?? null}
                calculated={stats.totalMarketRent ?? null}
                format="currency"
              />
            )}
            <ComparisonValue
              label="Total Sqft"
              stated={statedStats?.totalSqft ?? null}
              calculated={stats.totalSqft}
            />
            <ComparisonValue
              label="Occupancy Rate"
              stated={normalizeOccupancyRatePct(statedStats?.occupancyRate ?? null)}
              calculated={stats.physicalOccupancy}
              format="percent"
            />
            <ComparisonValue
              label="Occupied Units (incl. notice)"
              stated={statedStats?.occupiedUnits ?? null}
              calculated={stats.occupiedUnits + stats.noticeUnits}
              matchOverride={occupiedReconciliation?.ok}
              note={occupiedReconciliation && occupiedReconciliation.diff > 0 ? occupiedReconciliation.explanation : undefined}
            />
            <ComparisonValue
              label="Vacant Units"
              stated={statedStats?.vacantUnits ?? null}
              calculated={stats.vacantUnits}
              matchOverride={vacantReconciliation?.ok}
              note={vacantReconciliation && vacantReconciliation.diff > 0 ? vacantReconciliation.explanation : undefined}
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
        {(stats.totalMarketRent ?? null) !== null && (
          <div>
            <Text size="sm" c="dimmed">Total Market Rent</Text>
            <Text size="lg" fw={600}>{formatCurrency(stats.totalMarketRent ?? null)}</Text>
          </div>
        )}
        {(stats.totalSubsidyRent ?? null) !== null && (
          <>
            <div>
              <Text size="sm" c="dimmed">Subsidy</Text>
              <Text size="lg" fw={600}>{formatCurrency(stats.totalSubsidyRent ?? null)}</Text>
            </div>
            <div>
              <Text size="sm" c="dimmed">Tenant-Paid Rent</Text>
              <Text size="lg" fw={600}>{formatCurrency(stats.totalTenantPaidRent ?? null)}</Text>
            </div>
          </>
        )}
        {(stats.totalEmployeeDiscount ?? null) !== null && (
          <div>
            <Text size="sm" c="dimmed">Employee Discounts</Text>
            <Text size="lg" fw={600}>{formatCurrency(stats.totalEmployeeDiscount ?? null)}</Text>
          </div>
        )}
        {(stats.totalConcessions ?? null) !== null && (
          <div>
            <Text size="sm" c="dimmed">Concessions</Text>
            <Text size="lg" fw={600}>{formatCurrency(stats.totalConcessions ?? null)}</Text>
          </div>
        )}
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

// Type for tracking issue positions in the grid
interface IssuePosition {
  rowIndex: number;
  field: keyof UnitHighlights;
  type: 'outlier' | 'warning' | 'critical';
  message: string;
}

// Keyboard shortcuts help modal component
function KeyboardShortcutsHelp({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const shortcuts = [
    { keys: ['J', '↓'], description: 'Next issue' },
    { keys: ['K', '↑'], description: 'Previous issue' },
    { keys: ['Enter'], description: 'Edit selected cell' },
    { keys: ['Escape'], description: 'Cancel editing / Clear selection' },
    { keys: ['Tab'], description: 'Next cell' },
    { keys: ['Shift', 'Tab'], description: 'Previous cell' },
    { keys: ['⌘', 'S'], description: 'Save changes' },
    { keys: ['⌘', 'Shift', 'A'], description: 'Approve extraction' },
    { keys: ['N'], description: 'Add new unit' },
    { keys: ['?'], description: 'Show this help' },
  ];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm">
          <IconKeyboard size={24} />
          <Text fw={600}>Keyboard Shortcuts</Text>
        </Group>
      }
      size="md"
    >
      <Stack gap="xs">
        {shortcuts.map((shortcut, index) => (
          <Group key={index} justify="space-between" py="xs" style={{ borderBottom: index < shortcuts.length - 1 ? '1px solid var(--mantine-color-gray-2)' : 'none' }}>
            <Group gap="xs">
              {shortcut.keys.map((key, keyIndex) => (
                <span key={keyIndex}>
                  <Badge
                    variant="light"
                    color="gray"
                    size="lg"
                    style={{ fontFamily: 'monospace', minWidth: key.length > 1 ? 'auto' : 32, textAlign: 'center' }}
                  >
                    {key}
                  </Badge>
                  {keyIndex < shortcut.keys.length - 1 && (
                    <Text component="span" mx={4} c="dimmed" size="sm">+</Text>
                  )}
                </span>
              ))}
            </Group>
            <Text size="sm" c="dimmed">{shortcut.description}</Text>
          </Group>
        ))}
      </Stack>
      <Alert color="blue" variant="light" mt="md">
        <Text size="sm">
          Press <Badge variant="light" color="gray" size="sm" style={{ fontFamily: 'monospace' }}>J</Badge> / <Badge variant="light" color="gray" size="sm" style={{ fontFamily: 'monospace' }}>K</Badge> to quickly navigate between highlighted issues in the data grid.
        </Text>
      </Alert>
    </Modal>
  );
}

export default function ExtractionPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [extraction, setExtraction] = useState<RentRollExtraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [units, setUnits] = useState<GenericRentRollUnit[]>([]);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [showHighlighting, setShowHighlighting] = useState(true);
  const [newUnit, setNewUnit] = useState<Partial<GenericRentRollUnit>>({
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
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [currentIssueIndex, setCurrentIssueIndex] = useState<number>(-1);
  const gridRef = useRef<GridApi | null>(null);

  const fetchExtraction = useCallback(async () => {
    try {
      const local = getExtraction(id);
      if (local && local.status !== 'processing') {
        // Completed extractions live in localStorage (including review edits)
        setExtraction(local);
        setUnits(local.units);
        return;
      }

      // Missing locally or still processing: ask the server
      const response = await fetch(`/api/extraction/${id}`);
      if (response.ok) {
        const server: RentRollExtraction = await response.json();
        setExtraction(server);
        setUnits(server.units);
        if (server.status !== 'processing') {
          saveExtraction(server);
        }
        return;
      }

      if (local) {
        // Server lost it (restart) but we have the processing stub — show it;
        // polling will surface the stale/error state.
        setExtraction(local);
        setUnits(local.units);
        return;
      }

      notifications.show({
        title: 'Error',
        message: 'Extraction not found',
        color: 'red',
      });
      router.push('/');
    } catch (error) {
      console.error('Error fetching extraction:', error);
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    fetchExtraction();
  }, [fetchExtraction]);

  // Poll the server while the background job is running
  useEffect(() => {
    if (extraction?.status !== 'processing') return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/extraction/${id}`);
        if (!response.ok) return;
        const server: RentRollExtraction = await response.json();
        setExtraction(server);
        if (server.status !== 'processing') {
          setUnits(server.units);
          saveExtraction(server);
          notifications.show({
            title: server.status === 'error' ? 'Extraction failed' : 'Extraction complete',
            message: server.status === 'error'
              ? server.error ?? 'Unknown error'
              : `Extracted ${server.extractedUnitCount} units${server.statedUnitCount ? ` (stated: ${server.statedUnitCount})` : ''}`,
            color: server.status === 'error' ? 'red' : 'green',
          });
        }
      } catch {
        // transient network error — keep polling
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [extraction?.status, id]);

  const handleSave = () => {
    setSaving(true);
    try {
      // Recalculate summaryStats based on current units
      const newSummaryStats = calculateSummaryStats(units);

      const updated = updateStoredExtraction(id, {
        units,
        extractedUnitCount: units.length,
        summaryStats: newSummaryStats,
      });

      if (updated) {
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

  const handleApprove = () => {
    setSaving(true);
    try {
      // Recalculate summaryStats based on current units
      const newSummaryStats = calculateSummaryStats(units);

      const updated = updateStoredExtraction(id, {
        units,
        extractedUnitCount: units.length,
        summaryStats: newSummaryStats,
        status: 'approved',
      });

      if (updated) {
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

    // Recalculate summaryStats to ensure consistency in export
    const currentSummaryStats = calculateSummaryStats(units);

    const exportData = {
      ...extraction,
      units,
      extractedUnitCount: units.length,
      summaryStats: currentSummaryStats,
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

    // Prepare data for Excel export
    const exportData = units.map(unit => ({
      'Unit #': unit.unitNumber,
      'Status': unit.status,
      'Type': unit.unitType || '',
      'Sqft': unit.unitSqft || '',
      'Monthly Rent': unit.monthlyRent || '',
      'Market Rent': unit.marketRent ?? '',
      'Subsidy': unit.subsidyRent ?? '',
      'Employee Discount': unit.employeeDiscount ?? '',
      'Concession': unit.concession ?? '',
      'Tenant': unit.tenantName || '',
      'Lease Start': unit.leaseStartDate || '',
      'Lease End': unit.leaseEndDate || '',
      'Move In': unit.moveInDate || '',
      'Move Out': unit.moveOutDate || '',
      'Lease Status': unit.leaseStatus || '',
    }));

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Units');

    // Generate filename and download
    const fileName = `${extraction.fileName.replace(/\.[^/.]+$/, '')}_extracted.xlsx`;
    XLSX.writeFile(wb, fileName);
  };

  const handleUnitChange = useCallback((index: number, field: keyof GenericRentRollUnit, value: unknown) => {
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
    const optionalFields = ['unitType', 'unitSqft', 'marketRent', 'subsidyRent', 'employeeDiscount', 'concession', 'tenantName', 'leaseStartDate', 'leaseEndDate', 'moveInDate', 'moveOutDate', 'leaseStatus'] as const;
    const hasData: Record<string, boolean> = {};

    for (const field of optionalFields) {
      hasData[field] = units.some(unit => unit[field] !== null && unit[field] !== undefined && unit[field] !== '');
    }

    return hasData;
  }, [units]);

  // Calculate highlights for outliers and data quality issues
  const highlights = useMemo(() => detectHighlights(units), [units]);
  const highlightSummary = useMemo(() => getHighlightSummary(highlights), [highlights]);

  // Build sorted list of all issue positions for keyboard navigation
  const issuePositions = useMemo<IssuePosition[]>(() => {
    const positions: IssuePosition[] = [];
    const fieldOrder: (keyof UnitHighlights)[] = ['monthlyRent', 'unitSqft', 'tenantName', 'status'];

    highlights.forEach((unitHighlights, rowIndex) => {
      for (const field of fieldOrder) {
        const highlight = unitHighlights[field];
        if (highlight) {
          positions.push({
            rowIndex,
            field,
            type: highlight.type,
            message: highlight.message,
          });
        }
      }
    });

    // Sort by type priority (critical first), then by row
    const typePriority = { critical: 0, warning: 1, outlier: 2 };
    positions.sort((a, b) => {
      const priorityDiff = typePriority[a.type] - typePriority[b.type];
      if (priorityDiff !== 0) return priorityDiff;
      return a.rowIndex - b.rowIndex;
    });

    return positions;
  }, [highlights]);

  // Navigate to a specific issue in the grid
  const navigateToIssue = useCallback((index: number) => {
    if (index < 0 || index >= issuePositions.length || !gridRef.current) return;

    const issue = issuePositions[index];
    setCurrentIssueIndex(index);

    // Ensure row is visible
    gridRef.current.ensureIndexVisible(issue.rowIndex, 'middle');

    // Set focus on the cell
    gridRef.current.setFocusedCell(issue.rowIndex, issue.field);

    // Flash the row briefly for visibility
    const rowNode = gridRef.current.getDisplayedRowAtIndex(issue.rowIndex);
    if (rowNode) {
      gridRef.current.flashCells({ rowNodes: [rowNode], columns: [issue.field] });
    }

    // Show notification with issue details
    notifications.show({
      title: `${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)} Issue (${index + 1}/${issuePositions.length})`,
      message: issue.message,
      color: issue.type === 'critical' ? 'red' : issue.type === 'warning' ? 'orange' : 'yellow',
      autoClose: 2000,
    });
  }, [issuePositions]);

  // Keyboard navigation handlers
  const goToNextIssue = useCallback(() => {
    if (issuePositions.length === 0) return;
    const nextIndex = currentIssueIndex < issuePositions.length - 1 ? currentIssueIndex + 1 : 0;
    navigateToIssue(nextIndex);
  }, [currentIssueIndex, issuePositions.length, navigateToIssue]);

  const goToPrevIssue = useCallback(() => {
    if (issuePositions.length === 0) return;
    const prevIndex = currentIssueIndex > 0 ? currentIssueIndex - 1 : issuePositions.length - 1;
    navigateToIssue(prevIndex);
  }, [currentIssueIndex, issuePositions.length, navigateToIssue]);

  // Global keyboard event handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs or modals are open
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (addModalOpen || showShortcutsHelp) return;

      // Save: Cmd/Ctrl + S
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }

      // Approve: Cmd/Ctrl + Shift + A
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        if (extraction?.status !== 'approved') {
          handleApprove();
        }
        return;
      }

      // Skip other shortcuts if in input field
      if (isInputField) return;

      // Show help: ?
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutsHelp(true);
        return;
      }

      // Add unit: N
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setAddModalOpen(true);
        return;
      }

      // Next issue: J or ArrowDown (when not in grid)
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        goToNextIssue();
        return;
      }

      // Previous issue: K or ArrowUp (when not in grid)
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        goToPrevIssue();
        return;
      }

      // Escape: Clear current issue selection
      if (e.key === 'Escape') {
        setCurrentIssueIndex(-1);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addModalOpen, showShortcutsHelp, extraction?.status, goToNextIssue, goToPrevIssue, handleSave, handleApprove]);

  // Helper to get cell style based on highlight
  const getCellStyle = useCallback((rowIndex: number | null | undefined, field: keyof UnitHighlights) => {
    if (!showHighlighting || rowIndex === null || rowIndex === undefined) return {};

    const unitHighlights = highlights.get(rowIndex);
    if (!unitHighlights) return {};

    const highlight = unitHighlights[field];
    if (!highlight) return {};

    const colors = {
      outlier: { backgroundColor: 'rgba(255, 193, 7, 0.25)', borderLeft: '3px solid #ffc107' },
      warning: { backgroundColor: 'rgba(255, 152, 0, 0.25)', borderLeft: '3px solid #ff9800' },
      critical: { backgroundColor: 'rgba(244, 67, 54, 0.25)', borderLeft: '3px solid #f44336' },
    };

    const baseStyle = colors[highlight.type] || {};

    // Add focus ring if this is the currently focused issue
    if (currentIssueIndex >= 0 && currentIssueIndex < issuePositions.length) {
      const currentIssue = issuePositions[currentIssueIndex];
      if (currentIssue.rowIndex === rowIndex && currentIssue.field === field) {
        return {
          ...baseStyle,
          outline: '2px solid var(--mantine-color-blue-5)',
          outlineOffset: '-2px',
        };
      }
    }

    return baseStyle;
  }, [showHighlighting, highlights, currentIssueIndex, issuePositions]);

  // Helper to get tooltip for highlighted cells
  const getHighlightTooltip = useCallback((rowIndex: number | null | undefined, field: keyof UnitHighlights): string | undefined => {
    if (!showHighlighting || rowIndex === null || rowIndex === undefined) return undefined;

    const unitHighlights = highlights.get(rowIndex);
    if (!unitHighlights) return undefined;

    const highlight = unitHighlights[field];
    return highlight?.message;
  }, [showHighlighting, highlights]);

  // AG Grid column definitions
  const columnDefs = useMemo<ColDef<GenericRentRollUnit>[]>(() => {
    const allColumns: (ColDef<GenericRentRollUnit> & { field?: string })[] = [
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
        cellStyle: (params) => getCellStyle(params.node?.rowIndex, 'unitSqft'),
        tooltipValueGetter: (params) => getHighlightTooltip(params.node?.rowIndex, 'unitSqft'),
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
        cellStyle: (params) => getCellStyle(params.node?.rowIndex, 'monthlyRent'),
        tooltipValueGetter: (params) => getHighlightTooltip(params.node?.rowIndex, 'monthlyRent'),
      },
      {
        field: 'marketRent',
        headerName: 'Market Rent',
        width: 120,
        editable: true,
        type: 'numericColumn',
        valueFormatter: currencyFormatter,
        valueParser: currencyParser,
      },
      {
        field: 'subsidyRent',
        headerName: 'Subsidy',
        width: 110,
        editable: true,
        type: 'numericColumn',
        valueFormatter: currencyFormatter,
        valueParser: currencyParser,
      },
      {
        field: 'employeeDiscount',
        headerName: 'Empl. Discount',
        width: 130,
        editable: true,
        type: 'numericColumn',
        valueFormatter: currencyFormatter,
        valueParser: currencyParser,
      },
      {
        field: 'concession',
        headerName: 'Concession',
        width: 120,
        editable: true,
        type: 'numericColumn',
        valueFormatter: currencyFormatter,
        valueParser: currencyParser,
      },
      {
        field: 'tenantName',
        headerName: 'Tenant',
        width: 180,
        editable: true,
        cellStyle: (params) => getCellStyle(params.node?.rowIndex, 'tenantName'),
        tooltipValueGetter: (params) => getHighlightTooltip(params.node?.rowIndex, 'tenantName'),
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
    return allColumns.filter(col => {
      if (alwaysShowFields.includes(col.field)) return true;
      if (!col.field) return true; // Keep columns without field (like delete)
      return columnsWithData[col.field];
    });
  }, [handleDeleteUnit, showAllColumns, columnsWithData, getCellStyle, getHighlightTooltip]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
    tooltipShowDelay: 300,
  }), []);

  const onCellValueChanged = useCallback((event: CellValueChangedEvent<GenericRentRollUnit>) => {
    const { rowIndex, colDef, newValue } = event;
    if (rowIndex !== null && colDef.field) {
      handleUnitChange(rowIndex, colDef.field as keyof GenericRentRollUnit, newValue);
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

    setUnits([...units, newUnit as GenericRentRollUnit]);
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

  if (extraction.status === 'processing') {
    return <ProcessingView extraction={extraction} onBack={() => router.push('/')} />;
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
            <Tooltip label="Keyboard shortcuts (?)">
              <ActionIcon
                variant="subtle"
                size="lg"
                onClick={() => setShowShortcutsHelp(true)}
              >
                <IconKeyboard size={20} />
              </ActionIcon>
            </Tooltip>
            {issuePositions.length > 0 && showHighlighting && (
              <Group gap="xs">
                <Tooltip label="Previous issue (K)">
                  <Button
                    variant="light"
                    size="xs"
                    onClick={goToPrevIssue}
                  >
                    ← Prev
                  </Button>
                </Tooltip>
                <Badge variant="light" color="gray">
                  {currentIssueIndex >= 0 ? currentIssueIndex + 1 : '—'}/{issuePositions.length}
                </Badge>
                <Tooltip label="Next issue (J)">
                  <Button
                    variant="light"
                    size="xs"
                    onClick={goToNextIssue}
                  >
                    Next →
                  </Button>
                </Tooltip>
              </Group>
            )}
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

        {/* Non-standard format warning */}
        {extraction.sourceFormat?.includes('full-ai-extraction') && (
          <Alert
            icon={<IconAlertTriangle size={20} />}
            color="orange"
            variant="light"
            title="Non-Standard Format Detected"
          >
            <Text size="sm">
              This file has an unusual structure (multi-building layout, embedded subtotals, or non-standard columns).
              The parser used full AI extraction which may be less accurate than standard processing.
              Please review the extracted data carefully.
            </Text>
          </Alert>
        )}

        {/* Unit Count Card */}
        <UnitCountCard extraction={{ ...extraction, extractedUnitCount: units.length }} />

        {/* Verification Checks */}
        <VerificationChecksCard summary={extraction.verificationSummary} />

        {/* How the extraction ran: models tried, escalations, verification */}
        <ExtractionLogCard log={extraction.extractionLog} modelUsed={extraction.modelUsed} />

        {/* Mismatch Explanations */}
        <ExplanationsCard summary={extraction.explanationSummary} />

        {/* Validation Issues */}
        <ValidationIssuesCard issues={extraction.validationIssues} />

        {/* Summary Statistics */}
        <SummaryStatsCard stats={extraction.summaryStats} statedStats={extraction.statedSummaryStats} units={units} />

        {/* Units Table */}
        <Paper withBorder p="md">
          <Group justify="space-between" mb="md">
            <Group gap="md">
              <Title order={4}>Units ({units.length})</Title>
              {showHighlighting && highlightSummary.total > 0 && (
                <Group gap="xs">
                  {highlightSummary.critical > 0 && (
                    <Badge size="sm" color="red" variant="light">
                      {highlightSummary.critical} critical
                    </Badge>
                  )}
                  {highlightSummary.warnings > 0 && (
                    <Badge size="sm" color="orange" variant="light">
                      {highlightSummary.warnings} warnings
                    </Badge>
                  )}
                  {highlightSummary.outliers > 0 && (
                    <Badge size="sm" color="yellow" variant="light">
                      {highlightSummary.outliers} outliers
                    </Badge>
                  )}
                </Group>
              )}
            </Group>
            <Group gap="md">
              <Tooltip
                label={
                  <Stack gap={4}>
                    <Text size="xs" fw={500}>Smart Highlighting detects:</Text>
                    <Group gap="xs">
                      <div style={{ width: 12, height: 12, backgroundColor: 'rgba(244, 67, 54, 0.4)', borderRadius: 2 }} />
                      <Text size="xs">Critical issues (missing data)</Text>
                    </Group>
                    <Group gap="xs">
                      <div style={{ width: 12, height: 12, backgroundColor: 'rgba(255, 152, 0, 0.4)', borderRadius: 2 }} />
                      <Text size="xs">Warnings (suspicious values)</Text>
                    </Group>
                    <Group gap="xs">
                      <div style={{ width: 12, height: 12, backgroundColor: 'rgba(255, 193, 7, 0.4)', borderRadius: 2 }} />
                      <Text size="xs">Outliers (statistical anomalies)</Text>
                    </Group>
                  </Stack>
                }
                multiline
                w={250}
                withArrow
              >
                <Switch
                  label={
                    <Group gap={4}>
                      <IconSparkles size={14} />
                      <Text size="sm">Smart highlighting</Text>
                    </Group>
                  }
                  checked={showHighlighting}
                  onChange={(e) => setShowHighlighting(e.currentTarget.checked)}
                  size="sm"
                />
              </Tooltip>
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
              onGridReady={(params) => { gridRef.current = params.api; }}
              rowSelection="multiple"
              suppressRowClickSelection={true}
              animateRows={false}
              enableCellTextSelection={true}
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

      {/* Keyboard Shortcuts Help Modal */}
      <KeyboardShortcutsHelp
        opened={showShortcutsHelp}
        onClose={() => setShowShortcutsHelp(false)}
      />
    </Container>
  );
}
