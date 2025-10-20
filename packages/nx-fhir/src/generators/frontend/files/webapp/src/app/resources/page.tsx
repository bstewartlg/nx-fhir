'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Typography,
  Container,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  Alert,
  IconButton,
  SelectChangeEvent,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel, GridSortModel } from '@mui/x-data-grid';
import { Visibility as VisibilityIcon } from '@mui/icons-material';
import Editor from '@monaco-editor/react';
import { getFhirBaseUrl } from '@/lib/api-config';
import { useThemeMode } from '@/contexts/ThemeContext';
import { Bundle, CapabilityStatement, DomainResource } from 'fhir/r4';

export default function FhirPage() {
  const [resourceTypes, setResourceTypes] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<string>('');
  const [resources, setResources] = useState<DomainResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<DomainResource | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({
    page: 0,
    pageSize: 25,
  });
  const [sortModel, setSortModel] = useState<GridSortModel>([]);
  const [rowCount, setRowCount] = useState<number | undefined>(undefined);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const previousPageRef = useRef(0);
  const nextUrlRef = useRef<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);
  const { mode } = useThemeMode();

  // Fetch capability statement on mount
  useEffect(() => {
    const fetchCapabilityStatement = async () => {
      try {
        setLoading(true);
        const baseUrl = getFhirBaseUrl();
        const response = await fetch(`${baseUrl}/metadata`);

        if (!response.ok) {
          throw new Error('Failed to fetch capability statement');
        }

        const capability: CapabilityStatement = await response.json();

        // Extract resource types
        const types: string[] = [];
        if (capability.rest && capability.rest[0]?.resource) {
          capability.rest[0].resource.forEach((r) => {
            if (r.type) {
              types.push(r.type);
            }
          });
        }

        setResourceTypes(types.sort());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchCapabilityStatement();
  }, []);

  // Fetch resources when type is selected or pagination changes
  useEffect(() => {
    if (!selectedType) {
      setResources([]);
      return;
    }

    const fetchResources = async () => {
      try {
        setLoading(true);
        const baseUrl = getFhirBaseUrl();

        // Build sort parameter string
        let sortParam = '';
        if (sortModel.length > 0) {
          const sort = sortModel[0];
          // Map DataGrid field names to FHIR search parameter names
          let fhirSortParam = sort.field;
          if (sort.field === 'id') {
            fhirSortParam = '_id';
          } else if (sort.field === 'lastUpdated') {
            fhirSortParam = '_lastUpdated';
          }

          // Add '-' prefix for descending order (FHIR standard)
          sortParam = sort.sort === 'desc' ? `-${fhirSortParam}` : fhirSortParam;
        }

        // Determine which URL to use based on pagination direction
        let url: string;
        const isGoingForward = paginationModel.page > previousPageRef.current;
        const isGoingBackward = paginationModel.page < previousPageRef.current;

        if (paginationModel.page === 0 || !nextUrlRef.current && !prevUrlRef.current) {
          // First page or no pagination links available - build fresh search URL
          const params = new URLSearchParams();
          params.append('_count', paginationModel.pageSize.toString());

          if (sortParam) {
            params.append('_sort', sortParam);
          }

          url = `${baseUrl}/${selectedType}?${params.toString()}`;
        } else if (isGoingForward && nextUrlRef.current) {
          // Going forward - use next link from the bundle
          url = nextUrlRef.current;
        } else if (isGoingBackward && prevUrlRef.current) {
          // Going backward - use previous link from the bundle
          url = prevUrlRef.current;
        } else {
          // No valid pagination links - rebuild search from scratch
          const params = new URLSearchParams();
          params.append('_count', paginationModel.pageSize.toString());

          if (sortParam) {
            params.append('_sort', sortParam);
          }

          url = `${baseUrl}/${selectedType}?${params.toString()}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error('Failed to fetch resources');
        }

        const bundle: Bundle = await response.json();

        // Extract resources
        const fetchedResources = bundle.entry?.map((entry) => entry.resource as DomainResource) || [];
        setResources(fetchedResources);

        // Extract pagination links
        const links = bundle.link || [];
        const next = links.find((link) => link.relation === 'next');
        const prev = links.find((link) => link.relation === 'previous');

        setNextUrl(next?.url || null);
        setPrevUrl(prev?.url || null);
        nextUrlRef.current = next?.url || null;
        prevUrlRef.current = prev?.url || null;
        previousPageRef.current = paginationModel.page;

        // Set row count - only use bundle.total if it exists, otherwise set to undefined
        setRowCount(bundle.total ?? undefined);

        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setResources([]);
      } finally {
        setLoading(false);
      }
    };

    fetchResources();
  }, [selectedType, paginationModel, sortModel]);

  const handleResourceTypeChange = (event: SelectChangeEvent<string>) => {
    setSelectedType(event.target.value);
    setPaginationModel({ page: 0, pageSize: 25 });
    setSortModel([]);
    setNextUrl(null);
    setPrevUrl(null);
    previousPageRef.current = 0;
    nextUrlRef.current = null;
    prevUrlRef.current = null;
  };

  const handleSortModelChange = (newSortModel: GridSortModel) => {
    setSortModel(newSortModel);
    // Reset to first page when sort changes
    setPaginationModel({ ...paginationModel, page: 0 });
    previousPageRef.current = 0;
    nextUrlRef.current = null;
    prevUrlRef.current = null;
  };

  const handleViewResource = (resource: DomainResource) => {
    setSelectedResource(resource);
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setSelectedResource(null);
  };

  const handlePageChange = (newPage: number) => {
    setPaginationModel({ ...paginationModel, page: newPage });
  };

  const handlePageSizeChange = (newPageSize: number) => {
    setPaginationModel({ page: 0, pageSize: newPageSize });
    previousPageRef.current = 0;
    nextUrlRef.current = null;
    prevUrlRef.current = null;
  };

  const columns: GridColDef[] = [
    {
      field: 'id',
      headerName: 'ID',
      flex: 1,
      minWidth: 150,
    },
    {
      field: 'versionId',
      headerName: 'Version ID',
      flex: 1,
      minWidth: 150,
      sortable: false,
      valueGetter: (value, row) => row.meta?.versionId || 'N/A',
    },
    {
      field: 'lastUpdated',
      headerName: 'Last Updated',
      flex: 1,
      minWidth: 200,
      valueGetter: (value, row) => {
        if (row.meta?.lastUpdated) {
          return new Date(row.meta.lastUpdated).toLocaleString();
        }
        return 'N/A';
      },
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 100,
      sortable: false,
      renderCell: (params) => (
        <IconButton
          color="primary"
          onClick={() => handleViewResource(params.row)}
          aria-label="view resource"
        >
          <VisibilityIcon />
        </IconButton>
      ),
    },
  ];

  return (
    <Container sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        FHIR Resources Browser
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ mb: 3 }}>
        <FormControl fullWidth>
          <InputLabel id="resource-type-label">Resource Type</InputLabel>
          <Select
            labelId="resource-type-label"
            id="resource-type-select"
            value={selectedType}
            label="Resource Type"
            onChange={handleResourceTypeChange}
            disabled={loading || resourceTypes.length === 0}
          >
            {resourceTypes.map((type) => (
              <MenuItem key={type} value={type}>
                {type}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {loading && !selectedType && (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {selectedType && (
        <Box sx={{ height: 600, width: '100%' }}>
          <DataGrid
            rows={resources}
            columns={columns}
            hideFooter
            loading={loading}
            disableRowSelectionOnClick
            getRowId={(row) => row.id}
            sortingMode="server"
            sortModel={sortModel}
            onSortModelChange={handleSortModelChange}
            sx={{ mb: 2 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 2 }}>
            <Box>
              {rowCount !== undefined && (
                <Typography variant="body2" color="text.secondary">
                  Total: {rowCount} resources
                </Typography>
              )}
            </Box>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <InputLabel>Rows per page</InputLabel>
                <Select
                  value={paginationModel.pageSize}
                  label="Rows per page"
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                >
                  <MenuItem value={10}>10</MenuItem>
                  <MenuItem value={25}>25</MenuItem>
                  <MenuItem value={50}>50</MenuItem>
                  <MenuItem value={100}>100</MenuItem>
                </Select>
              </FormControl>
              <Typography variant="body2" color="text.secondary">
                Page {paginationModel.page + 1}
              </Typography>
              <Button
                variant="outlined"
                size="small"
                disabled={!prevUrl || loading}
                onClick={() => handlePageChange(paginationModel.page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outlined"
                size="small"
                disabled={!nextUrl || loading}
                onClick={() => handlePageChange(paginationModel.page + 1)}
              >
                Next
              </Button>
            </Box>
          </Box>
        </Box>
      )}

      {/* Resource Detail Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        maxWidth="lg"
        fullWidth
        PaperProps={{
          sx: { height: '80vh' },
        }}
      >
        <DialogTitle>
          {selectedResource?.resourceType}/{selectedResource?.id}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ height: '100%', pt: 1 }}>
            <Editor
              height="100%"
              defaultLanguage="json"
              value={JSON.stringify(selectedResource, null, 2)}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
              theme={mode === 'dark' ? 'vs-dark' : 'light'}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Close</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
