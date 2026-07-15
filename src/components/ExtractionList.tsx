'use client';

import { Table, Badge, Group, Text, ActionIcon, Tooltip, Stack, ThemeIcon, Box } from '@mantine/core';
import { IconEye, IconTrash, IconFileSpreadsheet, IconCircleCheck, IconX } from '@tabler/icons-react';
import type { ExtractionSummary } from '@/lib/types';
import { modelLabel } from '@/lib/utils/modelLabels';
import { formatUSD } from '@/lib/utils/aiCost';

interface ExtractionListProps {
  extractions: ExtractionSummary[];
  onView: (id: string) => void;
  onDelete: (id: string) => void;
}

function getStatusBadge(status: ExtractionSummary['status']) {
  const colors: Record<typeof status, string> = {
    processing: 'blue',
    review: 'yellow',
    approved: 'green',
    error: 'red',
  };

  return <Badge color={colors[status]}>{status}</Badge>;
}

function formatProcessingTime(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
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

function getCountBadge(extraction: ExtractionSummary) {
  if (extraction.countMatch === true) {
    return (
      <Badge color="green" variant="light">
        {extraction.extractedUnitCount} units (verified)
      </Badge>
    );
  }

  if (extraction.countMatch === false) {
    return (
      <Tooltip label={`Document states ${extraction.statedUnitCount} units`}>
        <Badge color="red" variant="light">
          {extraction.extractedUnitCount} units (mismatch!)
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Badge color="gray" variant="light">
      {extraction.extractedUnitCount} units (unverified)
    </Badge>
  );
}

function getVerificationBadge(extraction: ExtractionSummary) {
  const { verificationPassed, verificationFailed, verificationSkipped, verificationConfidence } = extraction;

  if (verificationPassed === null) {
    return <Text size="sm" c="dimmed">—</Text>;
  }

  const total = (verificationPassed ?? 0) + (verificationFailed ?? 0);
  const hasFailures = (verificationFailed ?? 0) > 0;

  const confidenceColors: Record<string, string> = {
    high: 'green',
    medium: 'yellow',
    low: 'red',
  };

  const color = verificationConfidence ? confidenceColors[verificationConfidence] : 'gray';

  const tooltipText = verificationSkipped && verificationSkipped > 0
    ? `${verificationPassed}/${total} passed (${verificationSkipped} skipped)`
    : `${verificationPassed}/${total} passed`;

  return (
    <Tooltip label={tooltipText}>
      <Badge
        color={color}
        variant="light"
        leftSection={hasFailures ? <IconX size={12} /> : <IconCircleCheck size={12} />}
      >
        {verificationPassed}/{total}
      </Badge>
    </Tooltip>
  );
}

export function ExtractionList({ extractions, onView, onDelete }: ExtractionListProps) {
  if (extractions.length === 0) {
    return (
      <Stack align="center" py="xl" gap="md">
        <ThemeIcon size={64} radius="xl" variant="light" color="gray">
          <IconFileSpreadsheet size={32} />
        </ThemeIcon>
        <div style={{ textAlign: 'center' }}>
          <Text fw={500} size="lg" c="dimmed">
            No extractions yet
          </Text>
          <Text size="sm" c="dimmed">
            Upload a rent roll above to get started
          </Text>
        </div>
      </Stack>
    );
  }

  return (
    <Box style={{ overflowX: 'auto' }}>
      <Table striped highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File Name</Table.Th>
            <Table.Th>Property</Table.Th>
            <Table.Th>Units</Table.Th>
            <Table.Th>Checks</Table.Th>
            <Table.Th>Issues</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Model</Table.Th>
            <Table.Th>Tokens</Table.Th>
            <Table.Th>Cost</Table.Th>
            <Table.Th>Time</Table.Th>
            <Table.Th>Uploaded</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
      <Table.Tbody>
        {extractions.map((extraction) => (
          <Table.Tr key={extraction.id}>
            <Table.Td>
              <Text size="sm" fw={500}>
                {extraction.fileName}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c={extraction.propertyName ? undefined : 'dimmed'}>
                {extraction.propertyName || '—'}
              </Text>
            </Table.Td>
            <Table.Td>{getCountBadge(extraction)}</Table.Td>
            <Table.Td>{getVerificationBadge(extraction)}</Table.Td>
            <Table.Td>
              {extraction.criticalIssues > 0 ? (
                <Badge color="red">{extraction.criticalIssues} critical</Badge>
              ) : (
                <Badge color="green">None</Badge>
              )}
            </Table.Td>
            <Table.Td>
              {extraction.error ? (
                <Tooltip label={extraction.error} multiline w={300}>
                  {getStatusBadge(extraction.status)}
                </Tooltip>
              ) : (
                getStatusBadge(extraction.status)
              )}
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {formatModelName(extraction.modelUsed)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {formatTokens(extraction.totalTokens)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {formatUSD(extraction.costUSD)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {formatProcessingTime(extraction.processingTimeMs)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {new Date(extraction.uploadedAt).toLocaleDateString()}
              </Text>
            </Table.Td>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <Tooltip label="View details">
                  <ActionIcon
                    variant="light"
                    color="blue"
                    onClick={() => onView(extraction.id)}
                  >
                    <IconEye size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Delete">
                  <ActionIcon
                    variant="light"
                    color="red"
                    onClick={() => onDelete(extraction.id)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
      </Table>
    </Box>
  );
}
