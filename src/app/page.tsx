'use client';

import { useState, useEffect, useCallback } from 'react';
import { Container, Title, Stack, Paper, Text, Group, Button, ThemeIcon, Box } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { IconUpload, IconHistory, IconRefresh } from '@tabler/icons-react';
import { FileUpload } from '@/components/FileUpload';
import { ExtractionList } from '@/components/ExtractionList';
import { getExtractionSummaries, deleteExtraction as deleteFromStorage } from '@/lib/clientStorage';
import type { ExtractionSummary } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [extractions, setExtractions] = useState<ExtractionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchExtractions = useCallback(() => {
    try {
      const summaries = getExtractionSummaries();
      setExtractions(summaries);
    } catch (error) {
      console.error('Error fetching extractions:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExtractions();
  }, [fetchExtractions]);

  const handleUploadComplete = (id: string) => {
    fetchExtractions();
    router.push(`/extraction/${id}`);
  };

  const handleView = (id: string) => {
    router.push(`/extraction/${id}`);
  };

  const handleDelete = (id: string) => {
    try {
      const deleted = deleteFromStorage(id);

      if (deleted) {
        notifications.show({
          title: 'Deleted',
          message: 'Extraction deleted successfully',
          color: 'green',
        });
        fetchExtractions();
      }
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: 'Failed to delete extraction',
        color: 'red',
      });
    }
  };

  return (
    <Container fluid px="xl" py="lg">
      <Stack gap="lg">
        <Paper withBorder p="xl" radius="lg">
          <Group gap="md" mb="lg">
            <ThemeIcon size={44} radius="md" variant="light" color="brand">
              <IconUpload size={24} />
            </ThemeIcon>
            <div>
              <Title order={3}>Upload Rent Roll</Title>
              <Text size="sm" c="dimmed">
                Drag and drop Excel or PDF files for AI-powered data extraction
              </Text>
            </div>
          </Group>
          <FileUpload onUploadComplete={handleUploadComplete} />
        </Paper>

        <Paper withBorder p="xl" radius="lg">
          <Group justify="space-between" align="flex-start" mb="lg">
            <Group gap="md">
              <ThemeIcon size={44} radius="md" variant="light" color="gray">
                <IconHistory size={24} />
              </ThemeIcon>
              <div>
                <Title order={3}>Recent Extractions</Title>
                <Text size="sm" c="dimmed">
                  {extractions.length} {extractions.length === 1 ? 'extraction' : 'extractions'} processed
                </Text>
              </div>
            </Group>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={fetchExtractions}
              loading={loading}
            >
              Refresh
            </Button>
          </Group>
          <Box>
            <ExtractionList
              extractions={extractions}
              onView={handleView}
              onDelete={handleDelete}
            />
          </Box>
        </Paper>
      </Stack>
    </Container>
  );
}
