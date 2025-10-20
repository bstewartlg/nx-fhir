'use client';

import { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { getFhirBaseUrl, getServerBaseUrl } from '@/lib/api-config';
import {
  Container,
  Typography,
  TextField,
  Button,
  Alert,
  Box,
  Paper,
  CircularProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useThemeMode } from '@/contexts/ThemeContext';

// Initial URLs for API and FHIR server
const INITIAL_API_URL = getServerBaseUrl() + '/api/hello';
const INITIAL_FHIR_URL = getFhirBaseUrl() + '/metadata';

export default function Home() {
  const [apiUrl, setApiUrl] = useState(INITIAL_API_URL);
  const [fhirServerUrl, setFhirServerUrl] = useState(INITIAL_FHIR_URL);
  const [apiResponse, setApiResponse] = useState<string>('');
  const [capabilityStatement, setCapabilityStatement] = useState<string>('');
  const [loadingApi, setLoadingApi] = useState(false);
  const [loadingFhir, setLoadingFhir] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [fhirError, setFhirError] = useState<string | null>(null);
  const { mode } = useThemeMode();

  const fetchFhirResponse = async (url: string) => {
    setLoadingFhir(true);
    setFhirError(null);
    try {
      const response = await fetch(`${url}`, {
        headers: {
          'Accept': 'application/fhir+json',
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setCapabilityStatement(JSON.stringify(data, null, 2));
    } catch (err) {
      setFhirError(err instanceof Error ? err.message : 'Failed to fetch CapabilityStatement');
      setCapabilityStatement('');
    } finally {
      setLoadingFhir(false);
    }
  };

  const fetchApiResponse = async (url: string) => {
    setLoadingApi(true);
    setApiError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.text();
      setApiResponse(data);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to fetch API response');
      setApiResponse('');
    } finally {
      setLoadingApi(false);
    }
  };

  useEffect(() => {
    // Fetch data using initial URLs on mount
    if (INITIAL_API_URL) {
      fetchApiResponse(INITIAL_API_URL);
    }
    if (INITIAL_FHIR_URL) {
      fetchFhirResponse(INITIAL_FHIR_URL);
    }
  }, []);

  const handleApiUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiUrl(e.target.value);
  };

  const handleFhirUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFhirServerUrl(e.target.value);
  };

  const handleConnect = () => {
    fetchFhirResponse(fhirServerUrl);
  };

  const handleApiRefresh = () => {
    fetchApiResponse(apiUrl);
  }

  return (
    <Container sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom fontWeight="bold">
        FHIR Server Browser
      </Typography>

      <Box sx={{ mt: 4 }}>
        {/* API Response Section */}
        <Paper elevation={2} sx={{ p: 3, mb: 4 }}>
          <Typography variant="h5" component="h2" gutterBottom>
            API Response
          </Typography>
          
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
            <TextField
              fullWidth
              label="API URL"
              value={apiUrl}
              onChange={handleApiUrlChange}
              placeholder="http://localhost:8080/api/hello"
              variant="outlined"
              size="small"
            />
            <Button
              variant="contained"
              onClick={handleApiRefresh}
              disabled={loadingApi}
              startIcon={loadingApi ? <CircularProgress size={20} /> : <RefreshIcon />}
              sx={{ minWidth: 120 }}
            >
              {loadingApi ? 'Loading' : 'Refresh'}
            </Button>
          </Box>

          {apiError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {apiError}
            </Alert>
          )}

          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <Editor 
              height="15vh"
              defaultLanguage="json"
              value={apiResponse || '// API response will appear here'}
              theme={mode === 'dark' ? 'vs-dark' : 'light'}
              options={{ readOnly: true }}
            />
          </Box>
        </Paper>

        {/* FHIR CapabilityStatement Section */}
        <Paper elevation={2} sx={{ p: 3 }}>
          <Typography variant="h5" component="h2" gutterBottom>
            FHIR CapabilityStatement
          </Typography>
          
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
            <TextField
              fullWidth
              label="FHIR Server Base URL"
              value={fhirServerUrl}
              onChange={handleFhirUrlChange}
              placeholder="http://localhost:8080/fhir"
              variant="outlined"
              size="small"
            />
            <Button
              variant="contained"
              onClick={handleConnect}
              disabled={loadingFhir}
              startIcon={loadingFhir ? <CircularProgress size={20} /> : <RefreshIcon />}
              sx={{ minWidth: 120 }}
            >
              {loadingFhir ? 'Loading' : 'Refresh'}
            </Button>
          </Box>

          {fhirError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {fhirError}
            </Alert>
          )}

          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <Editor
              height="60vh"
              defaultLanguage="json"
              value={capabilityStatement || '// Connect to a FHIR server to view its CapabilityStatement'}
              theme={mode === 'dark' ? 'vs-dark' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: true }
              }}
            />
          </Box>
        </Paper>
      </Box>
    </Container>
  );
}
