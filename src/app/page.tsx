'use client';

import { useState, useEffect, useCallback } from 'react';
import { Container, Title, Stack, Paper, Text, Group, Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { FileUpload } from '@/components/FileUpload';
import { ExtractionList } from '@/components/ExtractionList';
import type { ExtractionSummary } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [extractions, setExtractions] = useState<ExtractionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchExtractions = useCallback(async () => {
    try {
      const response = await fetch('/api/extractions');
      if (response.ok) {
        const data = await response.json();
        setExtractions(data);
      }
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

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`/api/extraction/${id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
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
    <Container size="xl" py="xl">
      <Stack gap="xl">
        <Group justify="space-between" align="center">
          <div>
            <Title order={1}>Rent Roll Parser</Title>
            <Text c="dimmed">
              Upload Excel or PDF rent rolls for AI-powered extraction
            </Text>
          </div>
        </Group>

        <Paper withBorder p="lg" radius="md">
          <Title order={3} mb="md">Upload Rent Roll</Title>
          <FileUpload onUploadComplete={handleUploadComplete} />
        </Paper>

        <Paper withBorder p="lg" radius="md">
          <Group justify="space-between" align="center" mb="md">
            <Title order={3}>Recent Extractions</Title>
            <Button variant="subtle" onClick={fetchExtractions} loading={loading}>
              Refresh
            </Button>
          </Group>
          <ExtractionList
            extractions={extractions}
            onView={handleView}
            onDelete={handleDelete}
          />
        </Paper>
      </Stack>
    </Container>
  );
}
