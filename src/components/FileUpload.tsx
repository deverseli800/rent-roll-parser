'use client';

import { useState, useRef, useEffect } from 'react';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { Group, Text, rem, Stack, Progress } from '@mantine/core';
import { IconUpload, IconX, IconFile } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

interface FileUploadProps {
  onUploadComplete: (id: string) => void;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, []);

  const startProgressSimulation = () => {
    // Simulate progress that slows down as it approaches 90%
    let currentProgress = 5;
    setProgress(currentProgress);
    setStatusMessage('Uploading file...');

    progressIntervalRef.current = setInterval(() => {
      // Slow down as we get closer to 90%
      const remaining = 90 - currentProgress;
      const increment = Math.max(0.5, remaining * 0.03);
      currentProgress = Math.min(89, currentProgress + increment);
      setProgress(currentProgress);

      // Update status message based on progress
      if (currentProgress > 10 && currentProgress <= 30) {
        setStatusMessage('Processing document...');
      } else if (currentProgress > 30 && currentProgress <= 50) {
        setStatusMessage('Extracting unit data with AI...');
      } else if (currentProgress > 50 && currentProgress <= 70) {
        setStatusMessage('Analyzing rent roll structure...');
      } else if (currentProgress > 70) {
        setStatusMessage('Validating extracted data...');
      }
    }, 200);
  };

  const stopProgressSimulation = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const handleDrop = async (files: File[]) => {
    if (files.length === 0) return;

    const file = files[0];
    setUploading(true);
    startProgressSimulation();

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      stopProgressSimulation();
      setProgress(95);
      setStatusMessage('Finalizing...');

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }

      setProgress(100);
      setStatusMessage('Complete!');

      notifications.show({
        title: 'Upload Complete',
        message: `Extracted ${result.extractedUnitCount} units${
          result.statedUnitCount ? ` (stated: ${result.statedUnitCount})` : ''
        }`,
        color: result.criticalIssues > 0 ? 'orange' : 'green',
      });

      onUploadComplete(result.id);
    } catch (error) {
      stopProgressSimulation();
      notifications.show({
        title: 'Upload Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setUploading(false);
      setProgress(0);
      setStatusMessage('');
    }
  };

  return (
    <Stack gap="md">
      <Dropzone
        onDrop={handleDrop}
        maxSize={50 * 1024 * 1024} // 50MB
        accept={[
          MIME_TYPES.xlsx,
          'application/vnd.ms-excel',
          MIME_TYPES.pdf,
        ]}
        loading={uploading}
        multiple={false}
        styles={{
          root: {
            borderWidth: 2,
            borderStyle: 'dashed',
            borderRadius: 12,
            backgroundColor: 'var(--mantine-color-gray-0)',
            transition: 'all 0.2s ease',
            '&:hover': {
              borderColor: 'var(--mantine-color-brand-5)',
              backgroundColor: 'var(--mantine-color-brand-0)',
            },
            '&[data-accept]': {
              borderColor: 'var(--mantine-color-brand-5)',
              backgroundColor: 'var(--mantine-color-brand-0)',
            },
            '&[data-reject]': {
              borderColor: 'var(--mantine-color-red-5)',
              backgroundColor: 'var(--mantine-color-red-0)',
            },
          },
        }}
      >
        <Stack align="center" justify="center" gap="md" mih={180} style={{ pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload
              style={{ width: rem(48), height: rem(48), color: 'var(--mantine-color-brand-6)' }}
              stroke={1.5}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              style={{ width: rem(48), height: rem(48), color: 'var(--mantine-color-red-6)' }}
              stroke={1.5}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFile
              style={{ width: rem(48), height: rem(48), color: 'var(--mantine-color-gray-5)' }}
              stroke={1.5}
            />
          </Dropzone.Idle>

          <div style={{ textAlign: 'center' }}>
            <Text size="lg" fw={500}>
              Drag a rent roll here or click to select
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              Supports Excel (.xlsx, .xls) and PDF files up to 50MB
            </Text>
          </div>
        </Stack>
      </Dropzone>

      {uploading && (
        <Stack gap="xs">
          <Progress value={progress} animated size="lg" radius="md" color="brand" />
          <Text size="sm" c="dimmed" ta="center" fw={500}>
            {statusMessage} {Math.round(progress)}%
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
