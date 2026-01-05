'use client';

import { Group, Text, Box, Container } from '@mantine/core';
import { IconBuildingSkyscraper } from '@tabler/icons-react';
import Link from 'next/link';

export function AppHeader() {
  return (
    <Box
      component="header"
      style={{
        height: 60,
        borderBottom: '1px solid var(--mantine-color-gray-2)',
        backgroundColor: 'white',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <Container fluid px="xl" h="100%">
        <Group h="100%" justify="space-between">
          <Link href="/" style={{ textDecoration: 'none' }}>
            <Group gap="sm">
              <Box
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, #00aa9d 0%, #008f84 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <IconBuildingSkyscraper size={22} color="white" stroke={1.5} />
              </Box>
              <div>
                <Text fw={600} size="lg" c="dark" lh={1.2}>
                  Rent Roll Parser
                </Text>
                <Text size="xs" c="dimmed" lh={1}>
                  AI-Powered Extraction
                </Text>
              </div>
            </Group>
          </Link>
        </Group>
      </Container>
    </Box>
  );
}
