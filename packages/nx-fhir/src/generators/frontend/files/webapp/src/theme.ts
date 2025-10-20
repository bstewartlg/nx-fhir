'use client';
import { PaletteMode } from '@mui/material/styles';
import { createTheme, ThemeOptions } from '@mui/material/styles';

export const getDesignTokens: (mode: PaletteMode) => ThemeOptions = (mode) => ({
  cssVariables: true,
  palette: {
    mode,
    ...(mode === 'light'
      ? {
          // Light mode colors
          primary: {
            main: '#1976d2',
          },
          secondary: {
            main: '#dc004e',
          },
          background: {
            default: '#ffffff',
            paper: '#f5f5f5',
          },
        }
      : {
          // Dark mode colors
          primary: {
            main: '#90caf9',
          },
          secondary: {
            main: '#f48fb1',
          },
          background: {
            default: '#0a0a0a',
            paper: '#1e1e1e',
          },
        }),
  },
  typography: {
    fontFamily: 'var(--font-roboto)',
  },
});

export const createAppTheme = (mode: PaletteMode) => createTheme(getDesignTokens(mode));
