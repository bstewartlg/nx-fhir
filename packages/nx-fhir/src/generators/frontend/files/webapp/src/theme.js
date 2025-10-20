'use client';
import { createTheme } from '@mui/material/styles';

export const getDesignTokens = (mode) => ({
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
          text: {
            primary: '#171717',
            secondary: '#666666',
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
          text: {
            primary: '#ededed',
            secondary: '#b0b0b0',
          },
        }),
  },
  typography: {
    fontFamily: 'var(--font-roboto)',
  },
});

export const createAppTheme = (mode) => createTheme(getDesignTokens(mode));
