import DashboardIcon from '@mui/icons-material/Dashboard';
import LocalFireDepartment from '@mui/icons-material/LocalFireDepartment';
import SettingsIcon from '@mui/icons-material/Settings';
import { MenuItem } from '../components/SidebarLayout';

export const menuItems: MenuItem[] = [
  { text: 'Dashboard', icon: <DashboardIcon />, href: '/' },
  { text: 'FHIR Resources', icon: <LocalFireDepartment />, href: '/resources' },
  { text: 'Settings', icon: <SettingsIcon />, href: '/settings' },
];
