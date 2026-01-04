'use client';

import { Table, Badge, Group, Text, ActionIcon, Tooltip } from '@mantine/core';
import { IconEye, IconTrash } from '@tabler/icons-react';
import type { ExtractionSummary } from '@/lib/types';

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
  // Shorten model names for display
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

export function ExtractionList({ extractions, onView, onDelete }: ExtractionListProps) {
  if (extractions.length === 0) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        No extractions yet. Upload a rent roll to get started.
      </Text>
    );
  }

  return (
    <Table striped highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>File Name</Table.Th>
          <Table.Th>Property</Table.Th>
          <Table.Th>Units</Table.Th>
          <Table.Th>Issues</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Model</Table.Th>
          <Table.Th>Tokens</Table.Th>
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
                {formatProcessingTime(extraction.processingTimeMs)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {new Date(extraction.uploadedAt).toLocaleDateString()}
              </Text>
            </Table.Td>
            <Table.Td>
              <Group gap="xs">
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
  );
}
