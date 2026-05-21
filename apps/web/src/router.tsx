import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from './layouts/AppShell';
import { AuthGuard } from './layouts/AuthGuard';
import { RootLayout } from './layouts/RootLayout';
import { AuthCallbackPage } from './pages/auth/AuthCallbackPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { InviteAcceptPage } from './pages/auth/InviteAcceptPage';
import { LoginPage } from './pages/auth/LoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { DashboardPage } from './pages/DashboardPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectPage } from './pages/project/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/forgot', element: <ForgotPasswordPage /> },
      { path: '/auth/callback', element: <AuthCallbackPage /> },
      { path: '/invite/:token', element: <InviteAcceptPage /> },
      {
        element: <AuthGuard />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, element: <Navigate to="/dashboard" replace /> },
              { path: '/dashboard', element: <DashboardPage /> },
              { path: '/project/:projectId', element: <ProjectPage /> },
              { path: '/settings', element: <SettingsPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
