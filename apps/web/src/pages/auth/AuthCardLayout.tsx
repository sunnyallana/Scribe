import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scribe/ui';

import type { ReactNode } from 'react';

interface AuthCardLayoutProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function AuthCardLayout({ title, description, children, footer }: AuthCardLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <CardTitle>{title}</CardTitle>
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-6">{children}</CardContent>
        {footer !== undefined && (
          <div className="border-t bg-muted/30 p-4 text-center text-sm">{footer}</div>
        )}
      </Card>
    </div>
  );
}
