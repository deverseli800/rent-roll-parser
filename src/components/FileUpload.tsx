'use client';

import { useState } from 'react';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { Text, rem, Stack, Progress } from '@mantine/core';
import { IconUpload, IconX, IconFile } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { saveExtraction } from '@/lib/clientStorage';
import type { RentRollExtraction } from '@/lib/types';
import classes from './FileUpload.module.css';

interface FileUploadProps {
  onUploadComplete: (id: string) => void;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);

  const handleDrop = async (files: File[]) => {
    if (files.length === 0) return;

    const file = files[0];
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Returns immediately with a 'processing' record; extraction continues
      // server-side and the extraction page polls for progress.
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const extraction: RentRollExtraction = await response.json();

      if (!response.ok) {
        throw new Error(extraction.error || 'Upload failed');
      }

      saveExtraction(extraction);

      notifications.show({
        title: 'Upload received',
        message: 'Extraction is running — you can watch its progress.',
        color: 'blue',
      });

      onUploadComplete(extraction.id);
    } catch (error) {
      notifications.show({
        title: 'Upload Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setUploading(false);
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
          'application/vnd.ms-excel.sheet.macroEnabled.12',
          MIME_TYPES.pdf,
        ]}
        loading={uploading}
        multiple={false}
        classNames={{ root: classes.root }}
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
              Supports Excel (.xlsx, .xls, .xlsm) and PDF files up to 50MB
            </Text>
          </div>
        </Stack>
      </Dropzone>

      {uploading && (
        <Stack gap="xs">
          <Progress value={100} animated size="lg" radius="md" color="brand" />
          <Text size="sm" c="dimmed" ta="center" fw={500}>
            Uploading…
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
