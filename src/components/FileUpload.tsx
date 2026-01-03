'use client';

import { useState } from 'react';
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

  const handleDrop = async (files: File[]) => {
    if (files.length === 0) return;

    const file = files[0];
    setUploading(true);
    setProgress(10);

    try {
      const formData = new FormData();
      formData.append('file', file);

      setProgress(30);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      setProgress(90);

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }

      setProgress(100);

      notifications.show({
        title: 'Upload Complete',
        message: `Extracted ${result.extractedUnitCount} units${
          result.statedUnitCount ? ` (stated: ${result.statedUnitCount})` : ''
        }`,
        color: result.criticalIssues > 0 ? 'orange' : 'green',
      });

      onUploadComplete(result.id);
    } catch (error) {
      notifications.show({
        title: 'Upload Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  return (
    <Stack>
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
      >
        <Group justify="center" gap="xl" mih={220} style={{ pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload
              style={{ width: rem(52), height: rem(52), color: 'var(--mantine-color-blue-6)' }}
              stroke={1.5}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              style={{ width: rem(52), height: rem(52), color: 'var(--mantine-color-red-6)' }}
              stroke={1.5}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFile
              style={{ width: rem(52), height: rem(52), color: 'var(--mantine-color-dimmed)' }}
              stroke={1.5}
            />
          </Dropzone.Idle>

          <div>
            <Text size="xl" inline>
              Drag a rent roll here or click to select
            </Text>
            <Text size="sm" c="dimmed" inline mt={7}>
              Supports Excel (.xlsx, .xls) and PDF files up to 50MB
            </Text>
          </div>
        </Group>
      </Dropzone>

      {uploading && (
        <Progress value={progress} animated />
      )}
    </Stack>
  );
}
