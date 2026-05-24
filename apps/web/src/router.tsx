import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from './layouts/AppShell';
import { AuthGuard } from './layouts/AuthGuard';
import { RootLayout } from './layouts/RootLayout';
import { AuthCallbackPage } from './pages/auth/AuthCallbackPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { InviteAcceptPage } from './pages/auth/InviteAcceptPage';
import { LoginPage } from './pages/auth/LoginPage';
import { SharePage } from './pages/auth/SharePage';
import { SignupPage } from './pages/auth/SignupPage';
import { DashboardPage } from './pages/DashboardPage';
import { ErrorPage } from './pages/ErrorPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectPage } from './pages/project/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: [
      { path: '/login', element: <LoginPage />, errorElement: <ErrorPage /> },
      { path: '/signup', element: <SignupPage />, errorElement: <ErrorPage /> },
      { path: '/forgot', element: <ForgotPasswordPage />, errorElement: <ErrorPage /> },
      { path: '/auth/callback', element: <AuthCallbackPage />, errorElement: <ErrorPage /> },
      { path: '/invite/:token', element: <InviteAcceptPage />, errorElement: <ErrorPage /> },
      { path: '/share/:token', element: <SharePage />, errorElement: <ErrorPage /> },
      {
        element: <AuthGuard />,
        errorElement: <ErrorPage />,
        children: [
          {
            element: <AppShell />,
            errorElement: <ErrorPage />,
            children: [
              { index: true, element: <Navigate to="/dashboard" replace /> },
              { path: '/dashboard', element: <DashboardPage />, errorElement: <ErrorPage /> },
              {
                path: '/project/:projectId',
                element: <ProjectPage />,
                errorElement: <ErrorPage />,
              },
              { path: '/settings', element: <SettingsPage />, errorElement: <ErrorPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
