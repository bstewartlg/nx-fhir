'use client';

import { useState, useEffect } from 'react';
import {
  Container,
  Typography,
  TextField,
  Button,
  Paper,
  Box,
  Alert,
  Divider,
  Stack,
  Chip,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestoreIcon from '@mui/icons-material/Restore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { getServerBaseUrl, getFhirBaseUrl } from '@/lib/api-config';

export default function SettingsPage() {
  const [serverUrl, setServerUrl] = useState('');
  const [fhirServerUrl, setFhirServerUrl] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load saved settings from localStorage or use defaults
    const savedServerUrl = localStorage.getItem('serverBaseUrl') || getServerBaseUrl();
    const savedFhirUrl = localStorage.getItem('fhirServerUrl') || getFhirBaseUrl();
    
    setServerUrl(savedServerUrl);
    setFhirServerUrl(savedFhirUrl);
  }, []);

  const handleSave = () => {
    try {
      // Validate URLs
      if (serverUrl && !isValidUrl(serverUrl)) {
        setError('Invalid Server Base URL format');
        return;
      }
      if (fhirServerUrl && !isValidUrl(fhirServerUrl)) {
        setError('Invalid FHIR Server URL format');
        return;
      }

      // Save to localStorage
      localStorage.setItem('serverBaseUrl', serverUrl);
      localStorage.setItem('fhirServerUrl', fhirServerUrl);

      setError(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      setError('Failed to save settings');
    }
  };

  const handleReset = () => {
    const defaultServerUrl = getServerBaseUrl();
    const defaultFhirUrl = getFhirBaseUrl();
    
    setServerUrl(defaultServerUrl);
    setFhirServerUrl(defaultFhirUrl);
    
    localStorage.removeItem('serverBaseUrl');
    localStorage.removeItem('fhirServerUrl');
    
    setError(null);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const isValidUrl = (url: string): boolean => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <Container sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom fontWeight="bold">
        Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Configure the base server URLs for API and FHIR queries
      </Typography>

      <Paper elevation={2} sx={{ p: 4 }}>
        <Stack spacing={3}>
          {saveSuccess && (
            <Alert 
              severity="success" 
              icon={<CheckCircleIcon />}
              onClose={() => setSaveSuccess(false)}
            >
              Settings saved successfully! Changes will take effect on next request.
            </Alert>
          )}

          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Box>
            <Typography variant="h6" gutterBottom>
              Server Configuration
            </Typography>
            <Divider sx={{ mb: 2 }} />
          </Box>

          <Box>
            <TextField
              fullWidth
              label="Server Base URL"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://localhost:8080"
              helperText="The base URL for your backend server (without trailing slash)"
              variant="outlined"
            />
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip 
                label="Default" 
                size="small" 
                variant="outlined"
                onClick={() => setServerUrl(getServerBaseUrl())}
              />
              <Chip 
                label="localhost:8080" 
                size="small" 
                variant="outlined"
                onClick={() => setServerUrl('http://localhost:8080')}
              />
            </Box>
          </Box>

          <Box>
            <TextField
              fullWidth
              label="FHIR Server URL"
              value={fhirServerUrl}
              onChange={(e) => setFhirServerUrl(e.target.value)}
              placeholder="http://localhost:8080/fhir"
              helperText="The complete URL to your FHIR server endpoint"
              variant="outlined"
            />
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip 
                label="Default" 
                size="small" 
                variant="outlined"
                onClick={() => setFhirServerUrl(getFhirBaseUrl())}
              />
              <Chip 
                label="localhost:8080/fhir" 
                size="small" 
                variant="outlined"
                onClick={() => setFhirServerUrl('http://localhost:8080/fhir')}
              />
              <Chip 
                label="HAPI R4Test Server" 
                size="small" 
                variant="outlined"
                onClick={() => setFhirServerUrl('http://hapi.fhir.org/baseR4')}
              />
            </Box>
          </Box>

          <Divider />

          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              startIcon={<RestoreIcon />}
              onClick={handleReset}
            >
              Reset to Defaults
            </Button>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSave}
            >
              Save Settings
            </Button>
          </Box>
        </Stack>
      </Paper>
    </Container>
  );
}
