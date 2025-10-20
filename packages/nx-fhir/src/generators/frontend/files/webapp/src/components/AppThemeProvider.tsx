'use client';

import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { createAppTheme } from '../theme';
import { ThemeContext } from '../contexts/ThemeContext';

export default function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check for saved preference or use system preference
    const savedMode = localStorage.getItem('themeMode') as 'light' | 'dark' | null;
    if (savedMode) {
      setMode(savedMode);
    } else {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setMode(mediaQuery.matches ? 'dark' : 'light');
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setMode((prevMode) => {
      const newMode = prevMode === 'light' ? 'dark' : 'light';
      localStorage.setItem('themeMode', newMode);
      return newMode;
    });
  }, []);

  const theme = useMemo(() => createAppTheme(mode), [mode]);

  useEffect(() => {
    // Ensure body background syncs with theme colors
    if (mounted && theme) {
      document.body.style.backgroundColor = theme.palette.background.default;
      document.body.style.color = theme.palette.text.primary;
    }
  }, [theme, mounted]);

  return (
    <ThemeContext.Provider value={{ mode, toggleTheme }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}
