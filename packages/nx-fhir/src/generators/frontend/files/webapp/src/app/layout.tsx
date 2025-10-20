import type { Metadata } from "next";
import "./globals.css";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { Roboto } from 'next/font/google';
import AppThemeProvider from '../components/AppThemeProvider';
import SidebarLayout from '../components/SidebarLayout';
import { menuItems } from './menu';

const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-roboto',
});

export const metadata: Metadata = {
  title: "FHIR Client",
  description: "Next.js FHIR frontend",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={roboto.variable}>
      <body>
        <AppRouterCacheProvider options={{ enableCssLayer: true }}>
          <AppThemeProvider>
            <SidebarLayout menuItems={menuItems}>
              {children}
            </SidebarLayout>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
