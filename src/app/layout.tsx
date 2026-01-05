import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { AppHeader } from "@/components/AppHeader";
import { theme } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rent Roll Parser",
  description: "Parse and validate rent rolls with AI-powered extraction",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ColorSchemeScript />
      </head>
      <body>
        <MantineProvider theme={theme}>
          <Notifications position="top-right" />
          <AppHeader />
          <main style={{ minHeight: 'calc(100vh - 60px)', backgroundColor: '#f8f9fa' }}>
            {children}
          </main>
        </MantineProvider>
      </body>
    </html>
  );
}
